import React, { useState, useEffect } from 'react';
import { Panel } from '../../types/panel';
import { websocketManager, WebSocketStatus } from '../services/websocketService';

interface PanelCardProps {
  panel: Panel;
  onDelete: () => void;
  onTestConnection: () => void;
  onSync: () => void;
}

const PanelCard: React.FC<PanelCardProps> = ({ panel, onDelete, onTestConnection, onSync }) => {
  const [websocketStatus, setWebsocketStatus] = useState<WebSocketStatus>('disconnected');

  useEffect(() => {
    const interval = setInterval(() => {
      const status = websocketManager.getStatus(panel.id);
      setWebsocketStatus(status);
    }, 2000);
    return () => clearInterval(interval);
  }, [panel.id]);

  const statusColor = {
    connected: 'bg-green-500',
    disconnected: 'bg-yellow-500',
    error: 'bg-red-500',
  }[panel.status];

  return (
    <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 hover:border-gray-600 transition-colors">
      <div className="flex justify-between items-start mb-3">
        <div>
          <h3 className="text-xl font-semibold truncate">{panel.name}</h3>
          <p className="text-gray-400 text-sm truncate">{panel.url}</p>
        </div>
        <div className="flex items-center">
          <div className={`w-3 h-3 rounded-full ${statusColor} mr-2`}></div>
          <span className="text-sm capitalize">{panel.status}</span>
          {websocketStatus !== 'disconnected' && (
            <span className="ml-2" title={`WebSocket ${websocketStatus}`}>
              <i className={`fas fa-bolt ${websocketStatus === 'connected' ? 'text-green-400' : websocketStatus === 'connecting' ? 'text-yellow-400' : 'text-red-400'}`}></i>
            </span>
          )}
        </div>
      </div>

      <div className="mb-4">
        <p className="text-gray-300 text-sm">
          <span className="text-gray-500">Admin:</span> {panel.username}
        </p>
        {panel.lastSync && (
          <p className="text-gray-300 text-sm mt-1">
            <span className="text-gray-500">Last sync:</span> {new Date(panel.lastSync).toLocaleString()}
          </p>
        )}
        {panel.error && (
          <p className="text-red-400 text-sm mt-1 truncate" title={panel.error}>
            Error: {panel.error}
          </p>
        )}
      </div>

      <div className="flex space-x-2">
        <button
          onClick={onSync}
          className="flex-1 px-3 py-2 bg-green-600 hover:bg-green-700 rounded-lg font-medium text-sm transition-colors"
          title="Sync accounts from this panel"
        >
          Sync Accounts
        </button>
        <button
          onClick={onTestConnection}
          className="flex-1 px-3 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium text-sm transition-colors"
        >
          Test Connection
        </button>
        <button
          onClick={onDelete}
          className="px-3 py-2 bg-gray-700 hover:bg-red-700 rounded-lg font-medium text-sm transition-colors"
          title="Delete panel"
        >
          Delete
        </button>
      </div>
    </div>
  );
};

export default PanelCard;