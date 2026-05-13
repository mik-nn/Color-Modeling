// src/App.tsx
import { useProfileStore } from './store/useProfileStore';
import { LinearityResult } from './types';
import ProfileUploader from './components/ProfileUploader';
import ProfileList from './components/ProfileList';
import ComparisonView from './components/ComparisonView';

function App() {
  const {
    profiles,
    selectedProfiles,
    isLoading,
    linearityResult,
    addProfiles,
    removeProfile,
    selectProfile,
    setLinearityResult,
  } = useProfileStore();

  const handleFilesSelected = async (files: FileList) => {
    // Пока используем mock loader
    const { loadMultipleProfiles } = await import('./lib/dataLoader');
    
    try {
      const loaded = await loadMultipleProfiles(files);
      addProfiles(loaded);
    } catch (err) {
      console.error(err);
      alert('Ошибка загрузки профилей');
    }
  };

  const handleAnalysisComplete = (result: LinearityResult) => {
    setLinearityResult(result);
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <div className="max-w-7xl mx-auto">
        <header className="border-b border-gray-800 bg-gray-900 py-6">
          <div className="px-8">
            <h1 className="text-4xl font-bold tracking-tight">Color Modeling</h1>
            <p className="text-gray-400 mt-2">
              Анализ линейной переносимости цветовых профилей
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

              <div className="mt-8">
                <h2 className="text-lg font-semibold mb-4">
                  Профили ({profiles.length})
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
              onAnalysisComplete={handleAnalysisComplete}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;