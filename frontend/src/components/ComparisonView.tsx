// src/components/ComparisonView.tsx
import { useEffect, useState } from 'react';
import { ProfileData, LinearityResult } from '../types';
import { analyzeLinearity } from '../lib/analyzers/linearityAnalyzer';
import LabScatterPlot from './LabScatterPlot';
import SpectralCurves from './SpectralCurves';

interface ComparisonViewProps {
  profiles: ProfileData[];
  onRemove: (fullName: string) => void;
  onAnalysisComplete?: (result: LinearityResult) => void;
}

export default function ComparisonView({ 
  profiles, 
  onRemove,
  onAnalysisComplete 
}: ComparisonViewProps) {
  const [analysisResult, setAnalysisResult] = useState<LinearityResult | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  
  // Automatically run linearity analysis when 2 profiles are selected
  useEffect(() => {
    if (profiles.length === 2) {
      try {
        const result = analyzeLinearity(profiles[0], profiles[1]);
        setAnalysisResult(result);
        setAnalysisError(null);
        onAnalysisComplete?.(result);
      } catch (error) {
        console.error('Linearity analysis failed:', error);
        setAnalysisError(error instanceof Error ? error.message : 'Analysis failed');
        setAnalysisResult(null);
      }
    } else {
      setAnalysisResult(null);
      setAnalysisError(null);
    }
  }, [profiles, onAnalysisComplete]);
  
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

      {/* Linearity Analysis Results */}
      {profiles.length === 2 && (
        <div className="bg-gray-900 border border-gray-700 rounded-2xl p-8">
          <h3 className="text-lg font-semibold mb-6">Анализ линейности переноса</h3>
          
          {analysisError ? (
            <div className="bg-red-900/20 border border-red-800 rounded-xl p-6 text-center">
              <p className="text-red-400 font-medium">Ошибка анализа</p>
              <p className="text-red-500 text-sm mt-2">{analysisError}</p>
            </div>
          ) : analysisResult ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <MetricCard
                label="Корреляция LAB"
                value={analysisResult.pearson_corr_lab.toFixed(4)}
                subtitle={`Pearson (${analysisResult.n_patches_used} патчей)`}
                color={analysisResult.pearson_corr_lab > 0.9 ? 'text-emerald-400' : analysisResult.pearson_corr_lab > 0.7 ? 'text-yellow-400' : 'text-red-400'}
              />
              
              <MetricCard
                label="R²"
                value={analysisResult.r_squared.toFixed(4)}
                subtitle="Коэф. детерминации"
                color={analysisResult.r_squared > 0.9 ? 'text-emerald-400' : analysisResult.r_squared > 0.7 ? 'text-yellow-400' : 'text-red-400'}
              />
              
              <MetricCard
                label="Стабильность"
                value={analysisResult.slope_stability_score.toFixed(4)}
                subtitle="Относительного растаскивания"
                color={analysisResult.slope_stability_score > 0.85 ? 'text-emerald-400' : analysisResult.slope_stability_score > 0.65 ? 'text-yellow-400' : 'text-red-400'}
              />

              <MetricCard
                label="ΔE после коррекции"
                value={analysisResult.mean_deltaE_after_correction?.toFixed(2) ?? '—'}
                subtitle="Среднее отклонение"
                color={analysisResult.mean_deltaE_after_correction && analysisResult.mean_deltaE_after_correction < 2 ? 'text-emerald-400' : 'text-yellow-400'}
              />

              <MetricCard
                label="Уверенность"
                value={analysisResult.linearity_confidence === 'high' ? 'Высокая' : analysisResult.linearity_confidence === 'medium' ? 'Средняя' : 'Низкая'}
                subtitle="Общая оценка"
                color={analysisResult.linearity_confidence === 'high' ? 'text-emerald-400' : analysisResult.linearity_confidence === 'medium' ? 'text-yellow-400' : 'text-red-400'}
              />

              <MetricCard
                label="Корреляция остатков"
                value={(analysisResult.pearson_corr_residuals ?? 0).toFixed(4)}
                subtitle="Линейность ошибок"
                color={(analysisResult.pearson_corr_residuals ?? 0) > 0.8 ? 'text-emerald-400' : 'text-yellow-400'}
              />
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <MetricCard label="Корреляция LAB" value="—" subtitle="Pearson" loading />
              <MetricCard label="R²" value="—" subtitle="Коэф. детерминации" loading />
              <MetricCard label="Стабильность" value="—" subtitle="Относительного растаскивания" loading />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface MetricCardProps {
  label: string;
  value: string | number;
  subtitle: string;
  loading?: boolean;
  color?: string;
}

function MetricCard({ label, value, subtitle, loading, color = 'text-white' }: MetricCardProps) {
  return (
    <div className="bg-gray-950 border border-gray-800 rounded-xl p-5">
      <p className="text-gray-400 text-sm">{label}</p>
      <p className={`text-4xl font-semibold mt-2 ${loading ? 'animate-pulse text-gray-600' : color}`}>
        {value}
      </p>
      <p className="text-xs text-gray-500 mt-1">{subtitle}</p>
    </div>
  );
}