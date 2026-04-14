import React from 'react';

interface PanelEmptyStateProps {
  onAdd: () => void;
}

const PanelEmptyState: React.FC<PanelEmptyStateProps> = ({ onAdd }) => (
  <div className="pcard-empty-state">
    <i className="fas fa-cloud" />
    <h3>No panels added yet</h3>
    <p>Add a webmail panel to start managing accounts</p>
    <button className="add-btn" onClick={onAdd}>
      <i className="fas fa-plus" /> Add Your First Panel
    </button>
  </div>
);

export default PanelEmptyState;
