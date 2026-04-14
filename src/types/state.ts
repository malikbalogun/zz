export interface AppState {
  activeView: 'dashboard' | 'panels' | 'accounts' | 'settings' | 'monitoring' | 'search';
  activeTag: string | null;
  monitoringRunning: boolean;
  searchQueue: string[]; // array of search job IDs
  lastSeenAlerts: string[]; // array of alert IDs already seen
  scrollPositions: Record<string, number>; // key: view+element, value: scrollTop
  lastState: {
    timestamp: string;
  };
  owaClientId?: string;
}

export const DEFAULT_STATE: AppState = {
  activeView: 'dashboard',
  activeTag: null,
  monitoringRunning: false,
  searchQueue: [],
  lastSeenAlerts: [],
  scrollPositions: {},
  lastState: { timestamp: new Date().toISOString() },
};