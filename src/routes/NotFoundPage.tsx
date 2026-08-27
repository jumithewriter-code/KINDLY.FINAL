import { Link, useLocation } from 'react-router-dom';
import { Icon } from '../components/Icon';

export function NotFoundPage() {
  const location = useLocation();
  return (
    <main className="auth-page" id="main-content">
      <div className="auth-card">
        <span className="onboarding-brand">
          <span className="brand-mark"><Icon name="i-heart" size={19} fill="currentColor" stroke="none" /></span> Kindly
        </span>
        <div className="auth-copy">
          <span className="eyebrow">NOTHING HERE</span>
          <h1>That page does not exist.</h1>
          <p>
            The address <code>{location.pathname}</code> did not match anything in Kindly. It may
            have been renamed, or the link may be old.
          </p>
        </div>
        <Link className="button coral full" to="/app">Go to my space</Link>
        <Link className="auth-switch" to="/auth/sign-in">Sign in instead</Link>
      </div>
      <div className="auth-art">
        <span className="eyebrow">KINDLY IS FOR</span>
        <h2>Small moments that feel a little easier.</h2>
      </div>
    </main>
  );
}
