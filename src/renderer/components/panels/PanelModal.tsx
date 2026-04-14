import React from 'react';

interface PanelModalProps {
  onClose: () => void;
  children: React.ReactNode;
}

const PanelModal: React.FC<PanelModalProps> = ({ onClose, children }) => (
  <div className="modal-overlay" onClick={onClose}>
    <div className="modal-content" onClick={e => e.stopPropagation()}>
      {children}
    </div>
  </div>
);

export default PanelModal;
