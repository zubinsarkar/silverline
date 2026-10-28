import { useState, useRef, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { GoogleSignIn } from '@capawesome/capacitor-google-sign-in';
import { FacebookSignIn } from '@capawesome/capacitor-facebook-sign-in';
import { useAuth } from '../../context/AuthContext';
import api from '../../api';
import Logo from '../../components/Logo';
import { isWebAuthnSupported, getAssertion } from '../../utils/webauthn';
import { showAppError } from '../../utils/errorBus';

const isNative = Capacitor.isNativePlatform();

export default function Login() {
const [form, setForm] = useState({ email: '', phone: '', password: '' });
const [showPassword, setShowPassword] = useState(false);
const { login } = useAuth();
const navigate = useNavigate();
const googleBtnRef = useRef(null);
const googleInitialized = useRef(false);
const [googleButtonBroken, setGoogleButtonBroken] = useState(false);

const goToRoleHome = (role) => {
if (role === 'admin') navigate('/dashboard');
else navigate('/home');
};

const handleSubmit = async (e) => {
e.preventDefault();
showAppError('');
if (!form.email.trim() && !form.phone.trim()) {
showAppError('Enter your email address or phone number');
return;
}
try {
// Backend matches this against either the stored email or the stored
// phone number, so either identifier logs in with the same password.
const identifier = form.email.trim() || form.phone.trim();
const res = await api.post('/auth/login', { email: identifier, password: form.password });
login(res.data.user, res.data.token);
goToRoleHome(res.data.user.role);
} catch (err) {
showAppError(err.response?.data?.error || 'Login failed');
}
};

// Google Identity Services (the web JS SDK below) relies on a popup/iframe
// OAuth flow that Google actively blocks inside embedded WebViews — exactly
// what every Capacitor app is — returning "disallowed_useragent" instead of
// ever completing sign-in. That's why the button silently did nothing in
// the actual app despite working fine in a real desktop/mobile browser.
// Native platforms get their own real Google Sign-In SDK below instead (see
// handleGoogleLoginNative + the initNativeAuth effect), so this whole GSI
// setup is web-only from here on.
useEffect(() => {
if (isNative) return;
const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
if (!clientId) return; // not configured yet — leave the slot empty rather than erroring

let cancelled = false;
const tryInit = () => {
if (cancelled) return;
if (!window.google?.accounts?.id) {
setTimeout(tryInit, 100);
return;
}
// React 18 StrictMode runs effects twice in dev, which calls initialize()
// and renderButton() twice back-to-back. Google's button then renders with
// its icon CSS classes missing (a 0x0 logo — invisible but still clickable),
// so guard to make sure this only ever actually runs once.
if (googleInitialized.current) return;
googleInitialized.current = true;
window.google.accounts.id.initialize({
client_id: clientId,
callback: async (response) => {
showAppError('');
try {
const res = await api.post('/auth/google', { credential: response.credential });
login(res.data.user, res.data.token);
goToRoleHome(res.data.user.role);
} catch (err) {
showAppError(err.response?.data?.error || 'Google sign-in failed');
}
},
});
if (googleBtnRef.current) {
googleBtnRef.current.innerHTML = '';
window.google.accounts.id.renderButton(googleBtnRef.current, {
type: 'icon', shape: 'circle', theme: 'outline', size: 'large',
});
// Google's GSI iframe sometimes fails to size itself — a known upstream
// quirk, reproduced even in a bare, unconstrained test div appended
// straight to document.body, so it isn't our CSS. It renders as an
// invisible 0x0 iframe (still "there", just not visible or clickable).
// Detect that once render settles and fall back to a manually styled
// button using Google's real "G" logo that still triggers their actual
// sign-in flow via prompt(), so the icon is always visible and working.
setTimeout(() => {
const iframe = googleBtnRef.current?.querySelector('iframe');
const rect = iframe?.getBoundingClientRect();
if (!rect || rect.width === 0 || rect.height === 0) {
setGoogleButtonBroken(true);
}
}, 500);
}
};
tryInit();
return () => { cancelled = true; };
// eslint-disable-next-line react-hooks/exhaustive-deps
}, []);

// Native Google Sign-In (@capawesome/capacitor-google-sign-in) + native
// Facebook Sign-In (@capawesome/capacitor-facebook-sign-in) — the real SDKs
// on iOS/Android instead of the web flows above, which either get silently
// blocked (Google) or rely on a popup+postMessage callback that the app's
// WebView never receives (Facebook — see handleFacebookLogin's own comment).
// Both must be initialize()'d once before signIn() can be called; harmless
// to skip entirely on web, where the JS-SDK-based flows further down handle
// things instead.
const nativeAuthInitialized = useRef(false);
useEffect(() => {
if (!isNative || nativeAuthInitialized.current) return;
nativeAuthInitialized.current = true;
if (Capacitor.getPlatform() === 'android') {
// Android has no Info.plist-equivalent auto-config, so the web client ID
// must be passed explicitly here — Android's Google Sign-In SDK uses it
// as the "server client ID" so the resulting ID token's audience is the
// backend-verifiable web client (see GOOGLE_CLIENT_ID handling in
// server/routes/auth.js).
const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
if (googleClientId) {
GoogleSignIn.initialize({ clientId: googleClientId }).catch(() => {});
}
} else {
// iOS: do NOT pass clientId here. The plugin reads GIDClientID straight
// out of Info.plist on its own — passing the web client ID (as this used
// to, unconditionally) silently overrode that and made the native app
// sign in AS the web client instead. The resulting ID token's audience
// was then always the web GOOGLE_CLIENT_ID, never GOOGLE_IOS_CLIENT_ID,
// so it kept failing server-side with "Invalid Google sign-in" — even
// though the sign-in flow itself completed successfully and looked fine
// from the app's side. See server/routes/auth.js's /google route.
GoogleSignIn.initialize().catch(() => {});
}
// appId/clientToken are read from the native Info.plist/AndroidManifest
// config on iOS/Android (see the setup guide) — nothing to pass here.
FacebookSignIn.initialize().catch(() => {});
}, []);

const handleGoogleLoginNative = async () => {
showAppError('');
try {
const result = await GoogleSignIn.signIn();
const res = await api.post('/auth/google', { credential: result.idToken });
login(res.data.user, res.data.token);
goToRoleHome(res.data.user.role);
} catch (err) {
if (err?.code === 'SIGN_IN_CANCELED' || err?.message?.toLowerCase().includes('cancel')) {
showAppError('Google sign-in was cancelled');
} else {
showAppError(err.response?.data?.error || err.message || 'Google sign-in failed');
}
}
};

// Facebook JS SDK — loaded lazily on first click rather than up front, since
// (unlike Google) Facebook doesn't require rendering their own button, so
// there's no need to have the SDK ready before the person interacts.
const ensureFacebookSdk = () => new Promise((resolve, reject) => {
if (window.FB) return resolve(window.FB);
const appId = import.meta.env.VITE_FACEBOOK_APP_ID;
if (!appId) return reject(new Error('Facebook sign-in is not configured'));
window.fbAsyncInit = () => {
window.FB.init({ appId, cookie: true, xfbml: false, version: 'v19.0' });
resolve(window.FB);
};
if (!document.getElementById('facebook-jssdk')) {
const script = document.createElement('script');
script.id = 'facebook-jssdk';
script.src = 'https://connect.facebook.net/en_US/sdk.js';
script.async = true;
script.defer = true;
document.body.appendChild(script);
}
});

// The web JS SDK's FB.login() opens a popup and waits for a postMessage
// back from it — inside a Capacitor WebView there's no real popup (or it
// opens external Safari/Chrome and never hands control back), so the
// person could complete Facebook's own consent screen and the app would
// still just sit there. That's the "works but doesn't log in" symptom.
// Native platforms use the real Facebook SDK below instead, which returns
// the access token directly, no popup involved.
const handleFacebookLoginNative = async () => {
showAppError('');
try {
// A nonce makes the native SDK also return an authenticationToken (a
// signed JWT) alongside the classic access token. That's what lets the
// backend fall back to it when the person declines App Tracking
// Transparency — iOS then makes the SDK return a null access token and
// silently switch to Limited Login instead (see MainViewController.swift's
// ATT comment and server/routes/auth.js's verifyFacebookAuthenticationToken).
const nonce = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
// Clear any token the SDK is still holding from a previous sign-in first.
// Without this, signIn() can hand back that cached token — which carries
// the nonce from whenever it was issued, not the one generated just above
// — and the backend rejects it as a nonce mismatch (see
// verifyFacebookAuthenticationToken in server/routes/auth.js). The symptom
// is a first sign-in that works and every one after it failing until the
// app is reinstalled. Ignore failures: there may be nothing to sign out of.
await FacebookSignIn.signOut().catch(() => {});
const result = await FacebookSignIn.signIn({ nonce });
if (!result.accessToken?.token && !result.authenticationToken) {
showAppError('Facebook sign-in was cancelled');
return;
}
const res = await api.post('/auth/facebook', {
accessToken: result.accessToken?.token,
authenticationToken: result.authenticationToken,
nonce,
});
login(res.data.user, res.data.token);
goToRoleHome(res.data.user.role);
} catch (err) {
showAppError(err.response?.data?.error || err.message || 'Facebook sign-in failed');
}
};

const handleFacebookLogin = async () => {
if (isNative) return handleFacebookLoginNative();
showAppError('');
try {
const FB = await ensureFacebookSdk();
FB.login((response) => {
if (!response.authResponse) {
showAppError('Facebook sign-in was cancelled');
return;
}
api.post('/auth/facebook', { accessToken: response.authResponse.accessToken })
.then((res) => { login(res.data.user, res.data.token); goToRoleHome(res.data.user.role); })
.catch((err) => showAppError(err.response?.data?.error || 'Facebook sign-in failed'));
}, { scope: 'email,public_profile' });
} catch (err) {
showAppError(err.message || 'Facebook sign-in is not available');
}
};

// Face ID and Fingerprint are both just the platform's biometric prompt via
// WebAuthn — there's no separate "Face ID API" vs "Fingerprint API" on the
// web, the OS picks whichever biometric it has. No email/phone needed: the
// server issues a passwordless challenge with no account attached yet (see
// POST /webauthn/login/options with no identifier), the platform prompts
// for any resident/discoverable credential it holds for this RP (see
// registerCredential's residentKey: 'required'), and the account itself is
// resolved from the credential's own userHandle in POST /webauthn/login/
// verify — only works for a device that was previously enrolled (from the
// registration page, or later from a profile settings page).
const handleBiometricLogin = async () => {
showAppError('');
if (!isWebAuthnSupported()) {
showAppError('Face ID / Fingerprint sign-in is not supported on this browser or device');
return;
}
try {
const optionsRes = await api.post('/webauthn/login/options', {});
const assertion = await getAssertion(optionsRes.data);
const verifyRes = await api.post('/webauthn/login/verify', assertion);
login(verifyRes.data.user, verifyRes.data.token);
goToRoleHome(verifyRes.data.user.role);
} catch (err) {
if (err?.name === 'NotAllowedError') {
showAppError('Face ID / Fingerprint sign-in was cancelled');
} else {
showAppError(err.response?.data?.error || err.message || 'Face ID / Fingerprint sign-in failed — sign in with your password first, then enable it from your profile.');
}
}
};

// fixed + overflow-hidden (not min-h-screen) so this page can never be
// scrolled or panned — including the browser's own "scroll focused input
// into view" behavior when the keyboard opens, which otherwise shifted
// this page up/down since it isn't part of any scrollable ancestor once
// positioned this way.
return (
<div className="fixed inset-0 flex overflow-hidden" style={{ background: '#f5f9f0' }}>
{/* Left panel */}
<div className="hidden md:flex md:w-1/2 flex-col justify-center items-center px-12"
style={{ background: '#f7f9f4' }}>
<div className="max-w-sm text-center">
<div className="flex justify-center mb-6">
<Logo height={90} />
</div>
<p className="text-gray-500 text-sm mt-2">Schweiz</p>
<p className="text-gray-600 text-lg mt-6 leading-relaxed">
Connecting helpers with people in need globally.
</p>
<p className="text-gray-400 text-sm mt-6 italic">
"Every contribution counts."
</p>
</div>
</div>

{/* Right panel */}
<div className="flex-1 flex items-center justify-center px-6">
<div className="w-full max-w-md">
{/* Mobile logo */}
<div className="md:hidden flex justify-center mb-8">
<Logo height={60} />
</div>

<div className="bg-white rounded-2xl shadow-lg p-8">
<h2 className="text-2xl font-bold text-gray-800 mb-1">Welcome</h2>
<p className="text-gray-500 text-sm mb-6">Sign in to your account</p>


<form onSubmit={handleSubmit}>
<div className="relative">
<label className="block text-sm font-medium text-gray-700 mb-1">Email address</label>
<input type="email" value={form.email}
onChange={e => setForm({ ...form, email: e.target.value })}
className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2"
style={{ '--tw-ring-color': '#3a6b00' }}
placeholder="you@example.com" />
{/* Centred on the midpoint between this input's bottom edge and the
    Phone number input's top edge — anchored to this field's own bottom
    (top: 100%) rather than the combined block, so the "Phone number"
    label above the next input doesn't throw off the centering. */}
<div className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none" style={{ top: 'calc(100% + 18px)' }}>
<span className="bg-white px-2 text-[11px] text-gray-400">OR</span>
</div>
</div>
<div className="mt-4">
<label className="block text-sm font-medium text-gray-700 mb-1">Phone number</label>
<input type="tel" value={form.phone}
onChange={e => setForm({ ...form, phone: e.target.value })}
className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2"
style={{ '--tw-ring-color': '#3a6b00' }}
placeholder="+41 79 123 45 67" />
</div>

<div className="mt-9">
<label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
<div className="relative">
<input type={showPassword ? 'text' : 'password'} required value={form.password}
onChange={e => setForm({ ...form, password: e.target.value })}
className="w-full border border-gray-300 rounded-lg pl-4 pr-10 py-2.5 text-sm focus:outline-none focus:ring-2"
placeholder="••••••••" />
<button type="button" onClick={() => setShowPassword(v => !v)}
aria-label={showPassword ? 'Hide password' : 'Show password'}
className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition">
{showPassword ? (
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
<path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-5.5 0-9.5-4-11-8 .77-2.02 2.13-3.9 3.83-5.36" />
<path d="M9.9 4.24A10.87 10.87 0 0 1 12 4c5.5 0 9.5 4 11 8a13.8 13.8 0 0 1-2.44 3.9" />
<path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
<line x1="2" y1="2" x2="22" y2="22" />
</svg>
) : (
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" />
<circle cx="12" cy="12" r="3" />
</svg>
)}
</button>
</div>
</div>
<div className="text-right mt-2">
<Link to="/forgot-password" className="text-xs hover:underline" style={{ color: '#3a6b00' }}>
Forgot password?
</Link>
</div>
<button type="submit"
className="w-full mt-4 text-white py-3 rounded-lg font-semibold text-sm transition hover:opacity-90"
style={{ backgroundColor: '#3a6b00' }}>
Sign In
</button>
</form>

<div className="mt-6 pt-5 border-t border-gray-100">
<p className="text-center text-xs text-gray-400 mb-3">Or continue with</p>
<div className="flex items-center justify-center gap-4">
{/* Google renders its own real button into this container (see the
    useEffect above) — required by Google's terms, a look-alike button
    can't trigger their sign-in flow. If Google's iframe fails to size
    itself (see the useEffect above), swap to a manual button with the
    real "G" logo that still triggers their actual flow via prompt().
    Falls back to a disabled placeholder if VITE_GOOGLE_CLIENT_ID isn't
    configured yet. */}
{import.meta.env.VITE_GOOGLE_CLIENT_ID ? (
isNative ? (
// Native platforms use the real Google Sign-In SDK (see
// handleGoogleLoginNative) — Google's own embeddable web button
// above never works inside a Capacitor WebView, so this is a
// plain styled button rather than Google's rendered iframe.
<button type="button" title="Google" aria-label="Continue with Google" onClick={handleGoogleLoginNative}
className="w-11 h-11 flex items-center justify-center border border-gray-300 rounded-full hover:bg-gray-50 transition">
<img src="https://developers.google.com/identity/images/g-logo.png" alt="" className="w-5 h-5" />
</button>
) : googleButtonBroken ? (
<button type="button" title="Google" aria-label="Continue with Google"
onClick={() => window.google?.accounts?.id?.prompt()}
className="w-11 h-11 flex items-center justify-center border border-gray-300 rounded-full hover:bg-gray-50 transition">
<img src="https://developers.google.com/identity/images/g-logo.png" alt="" className="w-5 h-5" />
</button>
) : (
<div ref={googleBtnRef} className="w-11 h-11 flex items-center justify-center overflow-hidden rounded-full" />
)
) : (
<button type="button" title="Google sign-in not configured" aria-label="Google sign-in not configured" disabled
className="w-11 h-11 flex items-center justify-center border border-gray-300 rounded-full opacity-50 cursor-not-allowed">
<img src="https://upload.wikimedia.org/wikipedia/commons/c/c1/Google_%22G%22_logo.svg" alt="" className="w-5 h-5" />
</button>
)}
{import.meta.env.VITE_FACEBOOK_APP_ID ? (
<button type="button" title="Facebook" aria-label="Continue with Facebook" onClick={handleFacebookLogin}
className="w-11 h-11 flex items-center justify-center border border-gray-300 rounded-full hover:bg-gray-50 transition">
<img src="https://cdn.simpleicons.org/facebook" alt="" className="w-5 h-5" />
</button>
) : (
<button type="button" title="Facebook sign-in not configured" aria-label="Facebook sign-in not configured" disabled
className="w-11 h-11 flex items-center justify-center border border-gray-300 rounded-full opacity-50 cursor-not-allowed">
<img src="https://cdn.simpleicons.org/facebook" alt="" className="w-5 h-5" />
</button>
)}
<button type="button" title="Face ID" aria-label="Continue with Face ID" onClick={handleBiometricLogin}
className="w-11 h-11 flex items-center justify-center border border-gray-300 rounded-full hover:bg-gray-50 transition text-gray-600">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="w-5 h-5">
<path d="M3 8V5.5A2.5 2.5 0 0 1 5.5 3H8" />
<path d="M16 3h2.5A2.5 2.5 0 0 1 21 5.5V8" />
<path d="M21 16v2.5a2.5 2.5 0 0 1-2.5 2.5H16" />
<path d="M8 21H5.5A2.5 2.5 0 0 1 3 18.5V16" />
<circle cx="9" cy="10.5" r="0.6" fill="currentColor" stroke="none" />
<circle cx="15" cy="10.5" r="0.6" fill="currentColor" stroke="none" />
<path d="M9 15c1 1 5 1 6 0" />
</svg>
</button>
<button type="button" title="Fingerprint" aria-label="Continue with fingerprint" onClick={handleBiometricLogin}
className="w-11 h-11 flex items-center justify-center border border-gray-300 rounded-full hover:bg-gray-50 transition">
<img src="https://fonts.gstatic.com/s/i/materialiconsoutlined/fingerprint/v12/24px.svg" alt="" className="w-5 h-5" />
</button>
</div>
</div>

<div className="mt-6 pt-5 border-t-2 border-gray-300 space-y-2 text-sm text-center text-gray-500">
<p>New helper?{' '}
<Link to="/verify-registration/helper" className="font-semibold hover:underline" style={{ color: '#3a6b00' }}>
Register
</Link>
</p>
<p>New beneficiary?{' '}
<Link to="/verify-registration/beneficiary" className="font-semibold hover:underline" style={{ color: '#3a6b00' }}>
Register
</Link>
</p>
</div>
</div>
</div>
</div>
</div>
);
}
