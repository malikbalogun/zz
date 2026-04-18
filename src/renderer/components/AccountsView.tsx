import React from 'react';

const AccountsView: React.FC = () => {
  return (
    <div className="p-8">
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 rounded-2xl p-8 mb-8 text-white shadow-xl">
        <h2 className="text-4xl font-bold mb-4">Accounts</h2>
        <p className="text-blue-100 text-lg">
          View and manage accounts synced from all connected panels.
        </p>
      </div>
      <div className="bg-gradient-to-br from-white to-gray-50 border border-gray-300 rounded-2xl p-12 text-center shadow-lg">
        <div className="text-blue-400 mb-6">
          <svg className="w-20 h-20 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
          </svg>
        </div>
        <h3 className="text-2xl font-semibold text-gray-900 mb-4">No accounts synced yet</h3>
        <p className="text-gray-600 max-w-md mx-auto mb-8">
          Sync accounts from your panels to see them here. Use the "Panels" view to connect to a panel, then click "Sync Accounts".
        </p>
        <div className="mt-6">
          <button className="px-6 py-3 bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white rounded-xl font-medium shadow">
            Go to Panels
          </button>
        </div>
      </div>
    </div>
  );
};

export default AccountsView;