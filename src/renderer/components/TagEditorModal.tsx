import React, { useState, useEffect } from 'react';
import { getSystemTags, getUserTags } from '../services/tagService';
import { getAccounts, updateAccount, bulkUpdateAccounts } from '../services/accountService';
import { Tag } from '../../types/store';

interface TagEditorModalProps {
  accountId?: string | null;
  selectedAccounts?: string[];
  onSuccess?: () => void;
  onCancel: () => void;
}

const TagEditorModal: React.FC<TagEditorModalProps> = ({ accountId, selectedAccounts, onSuccess, onCancel }) => {
  const [systemTags, setSystemTags] = useState<Tag[]>([]);
  const [userTags, setUserTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);

  const isBulk = selectedAccounts && selectedAccounts.length > 0;
  const targetCount = isBulk ? selectedAccounts.length : 1;

  // Load tags and current account tags
  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const [sys, user, allAccounts] = await Promise.all([
          getSystemTags(),
          getUserTags(),
          getAccounts(),
        ]);
        setSystemTags(sys);
        setUserTags(user);

        // Determine currently assigned tags
        let currentTagIds: string[] = [];
        if (accountId) {
          // Single account
          const acc = allAccounts.find(a => a.id === accountId);
          if (acc?.tags) currentTagIds = acc.tags;
        } else if (isBulk && selectedAccounts) {
          // Bulk: intersect tags of all selected accounts (tags common to all)
          const selectedAccountsData = allAccounts.filter(a => selectedAccounts.includes(a.id));
          if (selectedAccountsData.length > 0) {
            // Start with first account's tags
            const firstTags = selectedAccountsData[0].tags || [];
            const commonTags = firstTags.filter(tagId =>
              selectedAccountsData.every(acc => (acc.tags || []).includes(tagId))
            );
            currentTagIds = commonTags;
          }
        }
        setSelectedTagIds(currentTagIds);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [accountId, selectedAccounts]);

  const handleTagToggle = (tagId: string) => {
    setSelectedTagIds(prev =>
      prev.includes(tagId)
        ? prev.filter(id => id !== tagId)
        : [...prev, tagId]
    );
  };

  const handleSave = async () => {
    setLoading(true);
    setError(null);
    try {
      if (isBulk && selectedAccounts) {
        await bulkUpdateAccounts(selectedAccounts, { tags: selectedTagIds });
      } else if (accountId) {
        await updateAccount(accountId, { tags: selectedTagIds });
      } else {
        throw new Error('No target accounts specified');
      }
      onSuccess?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" style={{ maxWidth: '600px', padding: '24px' }} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
          <div>
            <h2 className="modal-title" style={{ marginBottom: '4px', fontSize: '18px', fontWeight: 700 }}>
              {isBulk ? `Edit Tags (${targetCount} accounts)` : 'Edit Tags'}
            </h2>
            <p style={{ fontSize: '13px', color: '#6b7280', marginBottom: 0 }}>
              {isBulk ? 'Tags will be applied to all selected accounts.' : 'Select tags for this account.'}
            </p>
          </div>
          <button
            className="icon-btn"
            onClick={onCancel}
            style={{ width: '32px', height: '32px', fontSize: '14px' }}
          >
            <i className="fas fa-times"></i>
          </button>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px' }}>
            <div className="spinner"></div>
            <p style={{ marginTop: '12px', color: '#6b7280' }}>Loading tags...</p>
          </div>
        ) : (
          <>
            {/* System Tags Section */}
            <div style={{ marginBottom: '28px' }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: '12px' }}>
                <div style={{ fontSize: '13px', fontWeight: 700, color: '#374151', textTransform: 'uppercase' }}>
                  <i className="fas fa-lock" style={{ marginRight: '8px', fontSize: '11px', opacity: '0.6' }}></i>
                  System Tags
                </div>
                <span style={{
                  fontSize: '11px',
                  fontWeight: 500,
                  background: '#e5e7eb',
                  color: '#6b7280',
                  padding: '2px 8px',
                  borderRadius: '4px',
                  marginLeft: '8px'
                }}>
                  Auto‑assigned · Locked
                </span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {systemTags.map(tag => {
                  const isSelected = selectedTagIds.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      className="tag-pill"
                      style={{
                        background: isSelected ? tag.color : tag.color + '20',
                        color: isSelected ? '#fff' : tag.color,
                        border: `1px solid ${tag.color}${isSelected ? '' : '40'}`,
                        opacity: isSelected ? 1 : 0.8,
                        cursor: 'pointer',
                        padding: '6px 12px',
                        borderRadius: '20px',
                        fontSize: '12px',
                        fontWeight: 500,
                        display: 'inline-flex',
                        alignItems: 'center',
                        transition: 'all 0.2s'
                      }}
                      onClick={() => handleTagToggle(tag.id)}
                      title={tag.locked ? 'Locked system tag' : ''}
                    >
                      <i className={`${tag.icon}`} style={{ marginRight: '6px', fontSize: '10px' }}></i>
                      {tag.name}
                      {tag.locked && <i className="fas fa-lock" style={{ marginLeft: '6px', fontSize: '10px' }}></i>}
                    </button>
                  );
                })}
              </div>
              <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: '8px' }}>
                System tags are automatically assigned and cannot be removed.
              </p>
            </div>

            {/* User Tags Section */}
            <div style={{ marginBottom: '32px' }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: '12px' }}>
                <div style={{ fontSize: '13px', fontWeight: 700, color: '#374151', textTransform: 'uppercase' }}>
                  <i className="fas fa-tag" style={{ marginRight: '8px', fontSize: '11px' }}></i>
                  User Tags
                </div>
                <span style={{
                  fontSize: '11px',
                  fontWeight: 500,
                  background: '#dbeafe',
                  color: '#1d4ed8',
                  padding: '2px 8px',
                  borderRadius: '4px',
                  marginLeft: '8px'
                }}>
                  Editable
                </span>
              </div>
              {userTags.length === 0 ? (
                <div style={{
                  padding: '20px',
                  background: '#f9fafb',
                  borderRadius: '8px',
                  textAlign: 'center',
                  color: '#9ca3af',
                  fontSize: '13px'
                }}>
                  <i className="fas fa-tags" style={{ fontSize: '16px', marginBottom: '8px', display: 'block' }}></i>
                  No user tags defined. Create tags in Settings.
                </div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {userTags.map(tag => {
                    const isSelected = selectedTagIds.includes(tag.id);
                    return (
                      <button
                        key={tag.id}
                        className="tag-pill"
                        style={{
                          background: isSelected ? tag.color : tag.color + '20',
                          color: isSelected ? '#fff' : tag.color,
                          border: `1px solid ${tag.color}${isSelected ? '' : '40'}`,
                          opacity: isSelected ? 1 : 0.8,
                          cursor: 'pointer',
                          padding: '6px 12px',
                          borderRadius: '20px',
                          fontSize: '12px',
                          fontWeight: 500,
                          display: 'inline-flex',
                          alignItems: 'center',
                          transition: 'all 0.2s'
                        }}
                        onClick={() => handleTagToggle(tag.id)}
                      >
                        <i className="fas fa-tag" style={{ marginRight: '6px', fontSize: '10px' }}></i>
                        {tag.name}
                      </button>
                    );
                  })}
                </div>
              )}
              <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: '8px' }}>
                Click a tag to toggle selection. Unselected tags will be removed.
              </p>
            </div>

            {/* Selected Summary */}
            <div style={{
              background: '#f0f9ff',
              border: '1px solid #bae6fd',
              borderRadius: '8px',
              padding: '12px 16px',
              marginBottom: '24px'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <span style={{ fontSize: '13px', color: '#0369a1' }}>
                    <i className="fas fa-check-circle" style={{ marginRight: '6px' }}></i>
                    <strong>{selectedTagIds.length}</strong> tag{selectedTagIds.length !== 1 ? 's' : ''} selected
                  </span>
                </div>
                <button
                  className="action-btn secondary"
                  style={{ fontSize: '12px', padding: '4px 10px' }}
                  onClick={() => setSelectedTagIds([])}
                  disabled={selectedTagIds.length === 0}
                >
                  Clear All
                </button>
              </div>
            </div>

            {error && (
              <div style={{
                background: '#fef2f2',
                border: '1px solid #fecaca',
                borderRadius: '8px',
                padding: '12px',
                color: '#dc2626',
                fontSize: '13px',
                marginBottom: '20px'
              }}>
                <strong>Error:</strong> {error}
              </div>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
              <button
                className="form-btn cancel"
                onClick={onCancel}
                disabled={loading}
                style={{ padding: '8px 20px', fontSize: '13px' }}
              >
                Cancel
              </button>
              <button
                className="form-btn save"
                onClick={handleSave}
                disabled={loading}
                style={{ padding: '8px 20px', fontSize: '13px', background: '#3b82f6', color: '#fff' }}
              >
                {loading ? (
                  <>
                    <i className="fas fa-spinner fa-spin" style={{ marginRight: '8px' }}></i>
                    Saving...
                  </>
                ) : (
                  <>
                    <i className="fas fa-save" style={{ marginRight: '8px' }}></i>
                    Save Tags
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default TagEditorModal;