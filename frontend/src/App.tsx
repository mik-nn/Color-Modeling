// src/App.tsx
import { useState } from 'react';
import { useProfileStore } from './store/useProfileStore';
import ProfileUploader from './components/ProfileUploader';
import ProfileList from './components/ProfileList';
import TransferView from './components/TransferView';
import KSweepView from './components/KSweepView';

// Dev-only: expose store on window for Playwright introspection and console
// debugging (e.g. extracting paper spectra to investigate OBA effects).
if (import.meta.env?.DEV && typeof window !== 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__store = useProfileStore;
}

function App() {
  const {
    profiles,
    isLoading,
    addProfiles,
    removeProfile,
  } = useProfileStore();

  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'transfer' | 'ksweep'>('transfer');

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
        <header className="border-b border-gray-800 bg-gray-900 py-5">
          <div className="px-8 space-y-2">
            <h1 className="text-3xl font-bold tracking-tight">Color Modeling</h1>
            <p className="text-sm text-gray-400">
              Cross-substrate spectral transfer · data-driven, no physical ink model
            </p>
            <div className="mt-2 text-xs text-gray-500 max-w-4xl leading-relaxed">
              <span className="font-semibold text-gray-300">Dataset:</span>{' '}
              <a
                href="https://www.epson.com/For-Work/Printers/Large-Format/SureColor-P9000-Standard-Edition-Printer/p/SCP9000SE"
                target="_blank" rel="noopener noreferrer"
                className="text-blue-300 hover:underline"
              >
                Epson SureColor SC-P9000
              </a>
              {' '}— 10-ink wide-format inkjet (PK/MK swap + Cyan, Vivid Magenta, Vivid
              Light Magenta, Yellow, Light Cyan, Light Black, Light Light Black, plus
              Green or Orange per print mode). Each ICC profile is addressed as 3-channel
              RGB; the printer driver performs the RGB → 10-ink separation internally with
              a proprietary LUT. <span className="text-yellow-300">We do NOT model individual
              inks</span> — predictions are empirical regressions between substrate spectra
              at matched RGB positions. CxF3 measurements: 905 patches × 36 wavelengths
              (380–730 nm @ 10 nm), M0 condition.
            </div>
          </div>
        </header>

        <div className="flex h-[calc(100vh-150px)]">
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
                  onRemove={removeProfile}
                />
              </div>
            </div>
          </div>

          {/* Main Area */}
          <div className="flex-1 overflow-auto">
            {/* Tab bar */}
            <div className="flex gap-0 border-b border-gray-800 px-6 pt-4 bg-gray-950 sticky top-0 z-10">
              {(['transfer', 'ksweep'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                    activeTab === tab
                      ? 'border-blue-500 text-blue-400'
                      : 'border-transparent text-gray-400 hover:text-gray-200'
                  }`}
                >
                  {tab === 'transfer' ? 'Transfer' : 'k-Sweep'}
                </button>
              ))}
            </div>
            <div className="p-8">
              {activeTab === 'transfer' ? (
                <TransferView profiles={profiles} />
              ) : (
                <KSweepView profiles={profiles} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
