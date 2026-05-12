// src/components/ComparisonView.tsx
import { ProfileData } from '../types';
import LabScatterPlot from './LabScatterPlot';
import SpectralCurves from './SpectralCurves';

interface ComparisonViewProps {
  profiles: ProfileData[];
  onRemove: (fullName: string) => void;
}

export default function ComparisonView({ profiles, onRemove }: ComparisonViewProps) {
  if (profiles.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-center">
        <div>
          <div className="text-6xl mb-6 opacity-20">📊</div>
          <h3 className="text-2xl font-medium text-gray-400 mb-3">
            Выберите профили для сравнения
          </h3>
          <p className="text-gray-500 max-w-md">
            Загрузите .icm профили и выберите от 1 до 2 для анализа 
            линейности, распределения цветов и спектральных свойств
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-10 pb-12">
      <div>
        <h2 className="text-3xl font-semibold mb-2">Сравнение профилей</h2>
        <p className="text-gray-400">
          {profiles.length} профиль{profiles.length > 1 ? 'я' : ''} выбрано для анализа
        </p>
      </div>

      {/* Карточки профилей */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {profiles.map((profile, index) => (
          <div 
            key={profile.metadata.full_name} 
            className="bg-gray-900 border border-gray-700 rounded-2xl p-6 hover:border-gray-600 transition-colors"
          >
            <div className="flex justify-between items-start mb-6">
              <div>
                <span className="inline-block px-3 py-1 text-xs font-medium rounded-full mb-3
                  bg-gradient-to-r from-blue-500/20 to-purple-500/20 text-blue-400">
                  {index === 0 ? 'REFERENCE' : 'TARGET'}
                </span>
                <h3 className="text-xl font-semibold text-white">
                  {profile.metadata.substrate}
                </h3>
                <p className="text-sm text-gray-400 mt-1 font-mono break-all">
                  {profile.metadata.full_name}
                </p>
              </div>

              <button
                onClick={() => onRemove(profile.metadata.full_name)}
                className="text-gray-400 hover:text-red-500 text-3xl leading-none transition-colors"
              >
                ×
              </button>
            </div>

            <div className="grid grid-cols-2 gap-y-4 text-sm">
              <div>
                <span className="text-gray-500 block">Патчей</span>
                <p className="text-lg font-semibold text-white">{profile.patch_count}</p>
              </div>
              <div>
                <span className="text-gray-500 block">Спектральные данные</span>
                <p className={`text-lg font-semibold ${profile.has_spectral ? 'text-emerald-400' : 'text-gray-500'}`}>
                  {profile.has_spectral ? 'Присутствуют' : 'Отсутствуют'}
                </p>
              </div>
              <div>
                <span className="text-gray-500 block">Серия</span>
                <p className="text-white">{profile.metadata.series}</p>
              </div>
              <div>
                <span className="text-gray-500 block">Принтер / Режим</span>
                <p className="text-white">{profile.metadata.printer} • {profile.metadata.ink}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* LAB Scatter Plot */}
      <div>
        <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
          Распределение цветов в CIELAB
        </h3>
        <LabScatterPlot profiles={profiles} width={820} height={620} />
      </div>

      {/* Spectral Curves */}
      <div>
        <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
          Спектральные кривые отражения
        </h3>
        <SpectralCurves profiles={profiles} width={820} height={520} />
      </div>

      {/* Блок анализа (заготовка) */}
      <div className="bg-gray-900 border border-gray-700 rounded-2xl p-8">
        <h3 className="text-lg font-semibold mb-6">Анализ линейности переноса</h3>
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-gray-950 border border-gray-800 rounded-xl p-5">
            <p className="text-gray-400 text-sm">Корреляция LAB</p>
            <p className="text-4xl font-semibold text-white mt-2">—</p>
            <p className="text-xs text-gray-500 mt-1">Pearson</p>
          </div>
          
          <div className="bg-gray-950 border border-gray-800 rounded-xl p-5">
            <p className="text-gray-400 text-sm">R² Residuals</p>
            <p className="text-4xl font-semibold text-white mt-2">—</p>
            <p className="text-xs text-gray-500 mt-1">Линейность остатков</p>
          </div>
          
          <div className="bg-gray-950 border border-gray-800 rounded-xl p-5">
            <p className="text-gray-400 text-sm">Стабильность</p>
            <p className="text-4xl font-semibold text-white mt-2">—</p>
            <p className="text-xs text-gray-500 mt-1">Относительного растаскивания</p>
          </div>
        </div>

        <p className="text-center text-sm text-gray-500 mt-8">
          Функционал расчёта линейности будет добавлен на следующем этапе
        </p>
      </div>
    </div>
  );
}