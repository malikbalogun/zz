import React, { useState } from 'react';

const SettingsView: React.FC = () => {
  const [autoSyncInterval, setAutoSyncInterval] = useState('Manual only');
  const [backgroundRefresh, setBackgroundRefresh] = useState(true);
  const [theme, setTheme] = useState('Light');
  const [showAnimations, setShowAnimations] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    // In a real implementation, save to store
    await new Promise(resolve => setTimeout(resolve, 500));
    setSaving(false);
    setSaveMessage('Settings saved successfully');
    setTimeout(() => setSaveMessage(null), 3000);
  };

  return (
    <div className="p-8">
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 rounded-2xl p-8 mb-8 text-white shadow-xl">
        <h2 className="text-4xl font-bold mb-4">Settings</h2>
        <p className="text-blue-100 text-lg">
          Configure the Panel Manager application.
        </p>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-gradient-to-br from-white to-gray-50 border border-gray-300 rounded-2xl p-6 shadow">
          <h3 className="text-xl font-semibold text-gray-900 mb-4">Sync & Refresh</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Auto‑sync interval</label>
              <select
                value={autoSyncInterval}
                onChange={(e) => setAutoSyncInterval(e.target.value)}
                className="w-full px-3 py-2 bg-white border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-800"
              >
                <option>Manual only</option>
                <option>Every 30 minutes</option>
                <option>Every hour</option>
                <option>Every 6 hours</option>
                <option>Every 24 hours</option>
              </select>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-700">Background token refresh</span>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={backgroundRefresh}
                  onChange={(e) => setBackgroundRefresh(e.target.checked)}
                />
                <div className="w-11 h-6 bg-gray-300 peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>
          </div>
        </div>
        <div className="bg-gradient-to-br from-white to-gray-50 border border-gray-300 rounded-2xl p-6 shadow">
          <h3 className="text-xl font-semibold text-gray-900 mb-4">Appearance</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Theme</label>
              <select
                value={theme}
                onChange={(e) => setTheme(e.target.value)}
                className="w-full px-3 py-2 bg-white border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-800"
              >
                <option>Light</option>
                <option>Dark</option>
                <option>System</option>
              </select>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-700">Show animations</span>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={showAnimations}
                  onChange={(e) => setShowAnimations(e.target.checked)}
                />
                <div className="w-11 h-6 bg-gray-300 peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>
          </div>
        </div>
        <div className="bg-gradient-to-br from-white to-gray-50 border border-gray-300 rounded-2xl p-6 lg:col-span-2 shadow">
          <h3 className="text-xl font-semibold text-gray-900 mb-4">About</h3>
          <div className="text-gray-700 space-y-2">
            <p><strong>Version:</strong> 0.1.0</p>
            <p><strong>Electron:</strong> {window.electron.versions.electron}</p>
            <p><strong>Node:</strong> {window.electron.versions.node}</p>
            <p><strong>Platform:</strong> {window.electron.platform}</p>
          </div>
          <div className="mt-6 flex items-center gap-4 flex-wrap">
            <button className="px-4 py-2 bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white rounded-xl font-medium shadow">
              Check for Updates
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 disabled:opacity-50 text-white rounded-xl font-medium shadow"
            >
              {saving ? 'Saving…' : 'Save Settings'}
            </button>
            {saveMessage && (
              <div className="text-green-600 font-medium">{saveMessage}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsView;