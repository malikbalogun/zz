import { useRef, useEffect, useCallback, useState } from 'react';

interface AutoSizeIframeProps {
  srcDoc: string;
  title: string;
  sandbox?: string;
  minHeight?: number;
  maxHeight?: number;
  style?: React.CSSProperties;
  className?: string;
}

const AutoSizeIframe: React.FC<AutoSizeIframeProps> = ({
  srcDoc,
  title,
  sandbox = '',
  minHeight = 120,
  maxHeight = 600,
  style,
  className,
}) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(minHeight);

  const updateHeight = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!doc?.body) return;
      const contentHeight = doc.documentElement.scrollHeight || doc.body.scrollHeight;
      setHeight(Math.max(minHeight, Math.min(maxHeight, contentHeight + 4)));
    } catch {
      // cross-origin — fall back to minHeight
    }
  }, [minHeight, maxHeight]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const handleLoad = () => {
      updateHeight();
      setTimeout(updateHeight, 100);
    };
    iframe.addEventListener('load', handleLoad);
    return () => iframe.removeEventListener('load', handleLoad);
  }, [updateHeight, srcDoc]);

  return (
    <iframe
      ref={iframeRef}
      title={title}
      sandbox={sandbox}
      srcDoc={srcDoc}
      className={className}
      style={{
        width: '100%',
        height,
        border: 'none',
        display: 'block',
        ...style,
      }}
    />
  );
};

export default AutoSizeIframe;
