// src/App.tsx
import { useState } from 'react';
import { useProfileStore } from './store/useProfileStore';
import ProfileUploader from './components/ProfileUploader';
import ProfileList from './components/ProfileList';
import ComparisonView from './components/ComparisonView';

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
          <div className="flex-1 overflow-auto p-8">
            <ComparisonView
              profiles={selectedProfiles}
              onRemove={removeProfile}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
