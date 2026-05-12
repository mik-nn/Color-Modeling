// src/components/ProfileUploader.tsx
import { useRef } from 'react';

interface ProfileUploaderProps {
  onFilesSelected: (files: FileList) => void;
  isLoading: boolean;
}

export default function ProfileUploader({ onFilesSelected, isLoading }: ProfileUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onFilesSelected(e.target.files);
      // Сброс input
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files.length > 0) {
      onFilesSelected(e.dataTransfer.files);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  return (
    <div>
      <h3 className="text-lg font-semibold mb-3">Загрузка профилей</h3>
      
      <div
        className="border-2 border-dashed border-gray-700 rounded-xl p-8 hover:border-gray-500 transition-colors cursor-pointer bg-gray-950"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onClick={() => fileInputRef.current?.click()}
      >
        <div className="text-center">
          <div className="mx-auto w-12 h-12 bg-gray-800 rounded-full flex items-center justify-center mb-4">
            📁
          </div>
          <p className="text-gray-300 font-medium">
            Перетащите .icm файлы сюда
          </p>
          <p className="text-gray-500 text-sm mt-1">или нажмите для выбора</p>
          
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".icm"
            className="hidden"
            onChange={handleFileChange}
          />

          <button
            className="mt-6 px-6 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            disabled={isLoading}
          >
            {isLoading ? 'Загрузка...' : 'Выбрать файлы'}
          </button>
        </div>
      </div>

      <p className="text-xs text-gray-500 mt-3 text-center">
        Поддерживаются файлы .icm (BC_*.icm)
      </p>
    </div>
  );
}