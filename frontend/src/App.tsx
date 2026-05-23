// src/App.tsx
import { useState } from 'react';
import { useProfileStore } from './store/useProfileStore';
import ProfileUploader from './components/ProfileUploader';
import ProfileList from './components/ProfileList';
import ComparisonView from './components/ComparisonView';
import TransferView from './components/TransferView';

// Dev-only: expose store on window for Playwright introspection and console
// debugging (e.g. extracting paper spectra to investigate OBA effects).
if (import.meta.env?.DEV && typeof window !== 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__store = useProfileStore;
}

type Tab = 'compare' | 'transfer';

function App() {
  const {
    profiles,
    selectedProfiles,
    isLoading,
    addProfiles,
    removeProfile,
    selectProfile,
  } = useProfileStore();

  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('compare');

  const handleFilesSelected = async (files: File[]) => {
    setLoadError(null);
    const { loadMultipleProfiles } = await import('./lib/dataLoader');
    try {
      const loaded = await loadMultipleProfiles(files);
      if (loaded.length === 0) {
        setLoadError('Files processed but no profiles loaded — unsupported format or parse error.');
        return;
      }
      addProfiles(loaded);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load profiles.');
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <div className="max-w-7xl mx-auto">
        <header className="border-b border-gray-800 bg-gray-900 py-6">
          <div className="px-8">
            <h1 className="text-4xl font-bold tracking-tight">Color Modeling</h1>
            <p className="text-gray-400 mt-2">
              Cross-substrate color profile linearity analysis
            </p>
          </div>
        </header>

        <div className="flex h-[calc(100vh-88px)]">
          {/* Sidebar */}
          <div className="w-96 border-r border-gray-800 bg-gray-900 overflow-auto">
            <div className="p-6">
              <ProfileUploader
                onFilesSelected={handleFilesSelected}
                isLoading={isLoading}
              />

              {loadError && (
                <div className="mt-4 p-3 rounded-lg bg-red-950 border border-red-800 text-red-300 text-sm">
                  {loadError}
                </div>
              )}

              <div className="mt-8">
                <h2 className="text-lg font-semibold mb-4">
                  Profiles ({profiles.length})
                </h2>
                <ProfileList
                  profiles={profiles}
                  selectedProfiles={selectedProfiles}
                  onSelect={selectProfile}
                  onRemove={removeProfile}
                />
              </div>
            </div>
          </div>

          {/* Main Area */}
          <div className="flex-1 overflow-auto">
            <div className="border-b border-gray-800 bg-gray-900 px-8 flex gap-1">
              <TabButton active={tab === 'compare'} onClick={() => setTab('compare')}>
                Compare (legacy)
              </TabButton>
              <TabButton active={tab === 'transfer'} onClick={() => setTab('transfer')}>
                Transfer (Phase 2 — A3 + S1)
              </TabButton>
            </div>
            <div className="p-8">
              {tab === 'compare' && (
                <ComparisonView
                  profiles={selectedProfiles}
                  onRemove={removeProfile}
                />
              )}
              {tab === 'transfer' && <TransferView profiles={profiles} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active, onClick, children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
        active
          ? 'text-gray-100 border-blue-500'
          : 'text-gray-400 border-transparent hover:text-gray-200'
      }`}
    >
      {children}
    </button>
  );
}

export default App;
