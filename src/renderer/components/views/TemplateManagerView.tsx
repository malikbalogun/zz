import { useState, useEffect, useMemo } from 'react';
import { getTemplates, addTemplate, updateTemplate, deleteTemplate, type EmailTemplate } from '../../services/templateService';
import HtmlPreviewModal from '../shared/HtmlPreviewModal';
import AutoSizeIframe from '../shared/AutoSizeIframe';

/** Build srcDoc for HTML preview: full documents pass through; fragments get a safe wrapper. */
function buildHtmlSrcDoc(html: string): string {
  const applied = applyPreviewPlaceholders(html);
  const t = applied.trim();
  if (/^<!DOCTYPE/i.test(t) || /^<html[\s>]/i.test(t)) {
    return applied;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Segoe UI,Roboto,sans-serif;padding:16px;margin:0;font-size:14px;color:#111827;}</style></head><body>${applied}</body></html>`;
}

/** Sample values so {{placeholders}} render in preview */
function applyPreviewPlaceholders(body: string): string {
  const samples: Record<string, string> = {
    name: 'Alex Johnson',
    company: 'Acme Corp',
    topic: 'Q1 Partnership',
    date: new Date().toLocaleDateString(),
    email: 'alex@example.com',
    phone: '+1 (555) 010-2030',
  };
  let out = body;
  for (const [k, v] of Object.entries(samples)) {
    out = out.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'gi'), v);
  }
  return out;
}

const TemplateManagerView: React.FC = () => {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EmailTemplate | null>(null);
  const [showForm, setShowForm] = useState(false);

  const [fName, setFName] = useState('');
  const [fSubject, setFSubject] = useState('');
  const [fBody, setFBody] = useState('');
  const [fType, setFType] = useState<'html' | 'plain'>('html');
  const [showEditorPreview, setShowEditorPreview] = useState(true);
  const [libraryPreview, setLibraryPreview] = useState<EmailTemplate | null>(null);
  const [fullPreview, setFullPreview] = useState<{ srcDoc: string; title: string } | null>(null);

  const reload = async () => {
    setTemplates(await getTemplates());
    setLoading(false);
  };
  useEffect(() => {
    reload();
  }, []);

  const previewHtml = useMemo(() => applyPreviewPlaceholders(fBody), [fBody]);
  const previewSubject = useMemo(() => applyPreviewPlaceholders(fSubject), [fSubject]);

  const resetForm = () => {
    setFName('');
    setFSubject('');
    setFBody('');
    setFType('html');
    setEditing(null);
    setShowForm(false);
  };

  const handleSave = async () => {
    if (!fName || !fSubject) return;
    if (editing) {
      await updateTemplate(editing.id, { name: fName, subject: fSubject, body: fBody, type: fType });
    } else {
      await addTemplate({ name: fName, subject: fSubject, body: fBody, type: fType });
    }
    resetForm();
    await reload();
  };

  const handleEdit = (t: EmailTemplate) => {
    setEditing(t);
    setFName(t.name);
    setFSubject(t.subject);
    setFBody(t.body);
    setFType(t.type);
    setShowForm(true);
    setLibraryPreview(null);
  };

  const handleDelete = async (id: string) => {
    await deleteTemplate(id);
    if (libraryPreview?.id === id) setLibraryPreview(null);
    await reload();
  };

  if (loading) return <div className="db-loading">Loading templates...</div>;

  return (
    <div className="feature-shell">
      <div className="feature-head">
        <h2>Template Manager</h2>
        <button
          className="action-btn primary"
          onClick={() => {
            resetForm();
            setShowForm(!showForm);
          }}
        >
          <i className={`fas ${showForm ? 'fa-times' : 'fa-plus'}`}></i> {showForm ? 'Cancel' : 'New Template'}
        </button>
      </div>

      {showForm && (
        <div className="feature-card" style={{ animation: 'slideDown 0.2s ease' }}>
          <div className="feature-card-title">{editing ? 'Edit Template' : 'Create Template'}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label className="form-label">Name</label>
              <input
                className="form-input"
                placeholder="Invoice Reminder"
                value={fName}
                onChange={e => setFName(e.target.value)}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label className="form-label">Type</label>
              <select className="form-input" value={fType} onChange={e => setFType(e.target.value as 'html' | 'plain')}>
                <option value="html">HTML</option>
                <option value="plain">Plain Text</option>
              </select>
            </div>
          </div>
          <div className="form-group" style={{ marginBottom: 8 }}>
            <label className="form-label">Subject</label>
            <input
              className="form-input"
              placeholder="Re: {{topic}}"
              value={fSubject}
              onChange={e => setFSubject(e.target.value)}
            />
            {fSubject.includes('{{') && (
              <div className="form-helper" style={{ marginTop: 4 }}>
                Preview: <strong>{previewSubject}</strong>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <label className="form-label" style={{ margin: 0 }}>
              Body
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" className="action-btn secondary" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => setShowEditorPreview(!showEditorPreview)}>
                <i className={`fas fa-${showEditorPreview ? 'eye-slash' : 'eye'}`}></i>{' '}
                {showEditorPreview ? 'Hide preview' : 'Show preview'}
              </button>
              {fType === 'html' && fBody.trim() && (
                <button
                  type="button"
                  className="action-btn secondary"
                  style={{ fontSize: 12, padding: '4px 10px' }}
                  onClick={() => setFullPreview({ srcDoc: buildHtmlSrcDoc(fBody), title: fName || 'Template Preview' })}
                >
                  <i className="fas fa-expand"></i> Fullscreen
                </button>
              )}
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: showEditorPreview ? '1fr 1fr' : '1fr',
              gap: 12,
              alignItems: 'stretch',
            }}
          >
            <div className="form-group" style={{ marginBottom: 0 }}>
              <textarea
                className="form-input"
                rows={14}
                placeholder="Write template body... Use {{name}}, {{company}}, etc."
                value={fBody}
                onChange={e => setFBody(e.target.value)}
                style={{ fontFamily: fType === 'plain' ? 'ui-monospace, monospace' : 'inherit', minHeight: 280 }}
              />
            </div>
            {showEditorPreview && (
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Live preview</label>
                <div
                  className="template-preview-frame"
                  style={{
                    border: '1px solid #e5e7eb',
                    borderRadius: 10,
                    minHeight: 280,
                    background: '#fff',
                    overflow: 'hidden',
                  }}
                >
                  {fType === 'html' ? (
                    <AutoSizeIframe
                      title="HTML template preview"
                      sandbox="allow-same-origin"
                      srcDoc={buildHtmlSrcDoc(fBody)}
                      minHeight={200}
                      maxHeight={500}
                    />
                  ) : (
                    <pre
                      style={{
                        margin: 0,
                        padding: 16,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        fontSize: 13,
                        color: '#374151',
                        minHeight: 248,
                      }}
                    >
                      {previewHtml || '—'}
                    </pre>
                  )}
                </div>
                <div className="form-helper" style={{ marginTop: 6 }}>
                  Placeholders are filled with sample data. Scripts are blocked in HTML preview.
                </div>
              </div>
            )}
          </div>

          <div className="feature-badges" style={{ marginBottom: 8, marginTop: 8 }}>
            <span className="feature-badge">{'{{name}}'}</span>
            <span className="feature-badge">{'{{company}}'}</span>
            <span className="feature-badge">{'{{topic}}'}</span>
            <span className="feature-badge">{'{{date}}'}</span>
            <span className="feature-badge">{'{{email}}'}</span>
          </div>
          <button className="action-btn primary" onClick={handleSave}>
            <i className="fas fa-check"></i> {editing ? 'Update' : 'Create'}
          </button>
        </div>
      )}

      <div className="feature-card">
        <div className="feature-card-title">Template Library ({templates.length})</div>
        {templates.length === 0 && (
          <div className="feature-muted" style={{ padding: '16px 0' }}>
            No templates yet. Create one to use in Email Sender.
          </div>
        )}
        {templates.map(t => (
          <div className="feature-row" key={t.id} style={{ alignItems: 'center' }}>
            <div style={{ flex: 1 }}>
              <strong>{t.name}</strong>
              <div className="feature-muted">
                Subject: {t.subject} · {t.type}
              </div>
            </div>
            <button
              className="icon-btn small"
              title="Preview"
              onClick={() => setLibraryPreview(libraryPreview?.id === t.id ? null : t)}
              style={{ marginRight: 4 }}
            >
              <i className="fas fa-eye"></i>
            </button>
            <button className="icon-btn small" title="Edit" onClick={() => handleEdit(t)} style={{ marginRight: 4 }}>
              <i className="fas fa-edit"></i>
            </button>
            <button className="icon-btn small" title="Delete" onClick={() => handleDelete(t.id)}>
              <i className="fas fa-trash"></i>
            </button>
          </div>
        ))}

        {libraryPreview && (
          <div
            style={{
              marginTop: 16,
              padding: 16,
              border: '1px solid #e5e7eb',
              borderRadius: 12,
              background: '#fafafa',
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
              <span>
                Preview: {libraryPreview.name}{' '}
                <span className="feature-muted" style={{ fontWeight: 400 }}>
                  ({libraryPreview.type})
                </span>
              </span>
              <div style={{ display: 'flex', gap: 4 }}>
                {libraryPreview.type === 'html' && (
                  <button
                    type="button"
                    className="icon-btn small"
                    onClick={() => setFullPreview({ srcDoc: buildHtmlSrcDoc(libraryPreview.body), title: libraryPreview.name })}
                    title="Fullscreen preview"
                  >
                    <i className="fas fa-expand"></i>
                  </button>
                )}
                <button type="button" className="icon-btn small" onClick={() => setLibraryPreview(null)} aria-label="Close preview">
                  <i className="fas fa-times"></i>
                </button>
              </div>
            </div>
            <div className="feature-muted" style={{ marginBottom: 10 }}>
              Subject: {applyPreviewPlaceholders(libraryPreview.subject)}
            </div>
            <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
              {libraryPreview.type === 'html' ? (
                <AutoSizeIframe
                  title="Library template preview"
                  sandbox="allow-same-origin"
                  srcDoc={buildHtmlSrcDoc(libraryPreview.body)}
                  minHeight={120}
                  maxHeight={600}
                />
              ) : (
                <pre
                  style={{
                    margin: 0,
                    padding: 16,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontSize: 13,
                    minHeight: 120,
                  }}
                >
                  {applyPreviewPlaceholders(libraryPreview.body)}
                </pre>
              )}
            </div>
          </div>
        )}
      </div>

      {fullPreview && (
        <HtmlPreviewModal
          srcDoc={fullPreview.srcDoc}
          title={fullPreview.title}
          onClose={() => setFullPreview(null)}
        />
      )}
    </div>
  );
};

export default TemplateManagerView;
