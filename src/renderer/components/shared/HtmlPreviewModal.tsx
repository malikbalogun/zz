import { useState, useCallback, useRef, useEffect } from 'react';

type ViewportPreset = 'desktop' | 'tablet' | 'mobile';

const VIEWPORT_WIDTHS: Record<ViewportPreset, number> = {
  desktop: 0,
  tablet: 768,
  mobile: 375,
};

interface HtmlPreviewModalProps {
  srcDoc: string;
  title?: string;
  onClose: () => void;
}

const HtmlPreviewModal: React.FC<HtmlPreviewModalProps> = ({ srcDoc, title = 'Preview', onClose }) => {
  const [viewport, setViewport] = useState<ViewportPreset>('desktop');
  const [zoom, setZoom] = useState(100);
  const overlayRef = useRef<HTMLDivElement>(null);

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  }, [onClose]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const viewportWidth = VIEWPORT_WIDTHS[viewport];

  return (
    <div
      ref={overlayRef}
      className="preview-modal-overlay"
      onClick={handleOverlayClick}
    >
      <div className="preview-modal">
        <div className="preview-modal-header">
          <div className="preview-modal-title">
            <i className="fas fa-eye"></i>
            <span>{title}</span>
          </div>
          <div className="preview-modal-controls">
            <div className="preview-viewport-switcher">
              {(['desktop', 'tablet', 'mobile'] as ViewportPreset[]).map(v => (
                <button
                  key={v}
                  type="button"
                  className={`preview-viewport-btn ${viewport === v ? 'active' : ''}`}
                  onClick={() => setViewport(v)}
                  title={v.charAt(0).toUpperCase() + v.slice(1)}
                >
                  <i className={`fas fa-${v === 'desktop' ? 'desktop' : v === 'tablet' ? 'tablet-alt' : 'mobile-alt'}`}></i>
                </button>
              ))}
            </div>
            <div className="preview-zoom-controls">
              <button
                type="button"
                className="preview-zoom-btn"
                onClick={() => setZoom(z => Math.max(50, z - 25))}
                disabled={zoom <= 50}
              >
                <i className="fas fa-minus"></i>
              </button>
              <span className="preview-zoom-label">{zoom}%</span>
              <button
                type="button"
                className="preview-zoom-btn"
                onClick={() => setZoom(z => Math.min(200, z + 25))}
                disabled={zoom >= 200}
              >
                <i className="fas fa-plus"></i>
              </button>
            </div>
            <button type="button" className="preview-close-btn" onClick={onClose}>
              <i className="fas fa-times"></i>
            </button>
          </div>
        </div>
        <div className="preview-modal-body">
          <div
            className="preview-iframe-container"
            style={{
              width: viewportWidth ? `${viewportWidth}px` : '100%',
              maxWidth: '100%',
              margin: viewportWidth ? '0 auto' : undefined,
            }}
          >
            <iframe
              title={title}
              sandbox=""
              srcDoc={srcDoc}
              className="preview-iframe"
              style={{
                transform: `scale(${zoom / 100})`,
                transformOrigin: 'top left',
                width: `${10000 / zoom}%`,
                height: `${10000 / zoom}%`,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default HtmlPreviewModal;
