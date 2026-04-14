import React from 'react';

interface ErrorBannerProps {
  message: string;
  onDismiss: () => void;
}

const ErrorBanner: React.FC<ErrorBannerProps> = ({ message, onDismiss }) => (
  <div className="pcard-error-banner">
    <i className="fas fa-exclamation-circle" /> {message}
    <button onClick={onDismiss} className="pcard-error-dismiss" aria-label="Dismiss error">
      <i className="fas fa-times" />
    </button>
  </div>
);

export default ErrorBanner;
