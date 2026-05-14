// src/components/SpectralCurves.tsx
import { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { ProfileData } from '../types';

interface SpectralCurvesProps {
  profiles: ProfileData[];
  width?: number;
  height?: number;
}

export default function SpectralCurves({ 
  profiles, 
  width = 780, 
  height = 520 
}: SpectralCurvesProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!svgRef.current || profiles.length === 0) return;

    d3.select(svgRef.current).selectAll("*").remove();

    const margin = { top: 30, right: 60, bottom: 60, left: 60 };
    const w = width - margin.left - margin.right;
    const h = height - margin.top - margin.bottom;

    const svg = d3.select(svgRef.current)
      .attr("width", width)
      .attr("height", height)
      .append("g")
      .attr("transform", `translate(${margin.left},${margin.top})`);

    // Цвета для разных профилей
    const colors = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6'];

    // Собираем все спектры
    const allCurves: Array<{
      wavelength: number;
      reflectance: number;
      substrate: string;
      color: string;
    }> = [];

    profiles.forEach((profile, idx) => {
      const color = colors[idx % colors.length];
      
profile.raw.forEach((patch, _patchIndex) => {
       if (!patch.spectra || !patch.wavelengths) return;

        patch.spectra.forEach((reflectance, i) => {
          allCurves.push({
            wavelength: patch.wavelengths![i],
            reflectance: reflectance * 100, // в проценты
            substrate: profile.metadata.substrate,
            color
          });
        });
      });
    });

    // Масштабы
    const xScale = d3.scaleLinear()
      .domain([380, 730])
      .range([0, w]);

    const yScale = d3.scaleLinear()
      .domain([0, 100])
      .range([h, 0]);

    // Оси
    svg.append("g")
      .attr("transform", `translate(0,${h})`)
      .call(d3.axisBottom(xScale).ticks(10));

    svg.append("g")
      .call(d3.axisLeft(yScale).ticks(10));

    // Подписи
    svg.append("text")
      .attr("x", w / 2)
      .attr("y", h + 45)
      .attr("text-anchor", "middle")
      .attr("fill", "#9ca3af")
      .text("Длина волны (нм)");

    svg.append("text")
      .attr("transform", "rotate(-90)")
      .attr("x", -h / 2)
      .attr("y", -45)
      .attr("text-anchor", "middle")
      .attr("fill", "#9ca3af")
      .text("Отражение (%)");

    // Группируем по субстрату для линий
    const nested = d3.group(allCurves, d => d.substrate);

    nested.forEach((points, _substrate) => {
      const color = points[0].color;

      // Создаём линию
      const line = d3.line<{wavelength: number, reflectance: number}>()
        .x(d => xScale(d.wavelength))
        .y(d => yScale(d.reflectance))
        .curve(d3.curveBasis);

      // Усреднённая кривая по всем патчам (или можно показывать несколько)
      const avgByWavelength = d3.rollup(
        points,
        v => d3.mean(v, d => d.reflectance) || 0,
        d => d.wavelength
      );

      const avgData = Array.from(avgByWavelength.entries())
        .map(([wavelength, reflectance]) => ({ wavelength, reflectance }))
        .sort((a, b) => a.wavelength - b.wavelength);

      svg.append("path")
        .datum(avgData)
        .attr("fill", "none")
        .attr("stroke", color)
        .attr("stroke-width", 2.5)
        .attr("stroke-opacity", 0.85)
        .attr("d", line);
    });

    // Легенда
    const legend = svg.append("g")
      .attr("transform", `translate(${w - 140}, 20)`);

    profiles.forEach((profile, i) => {
      const g = legend.append("g")
        .attr("transform", `translate(0, ${i * 28})`);

      g.append("line")
        .attr("x1", 0)
        .attr("y1", 8)
        .attr("x2", 24)
        .attr("y2", 8)
        .attr("stroke", colors[i % colors.length])
        .attr("stroke-width", 3);

      g.append("text")
        .attr("x", 32)
        .attr("y", 12)
        .attr("fill", "#e5e7eb")
        .attr("font-size", "13px")
        .text(profile.metadata.substrate);
    });

  }, [profiles, width, height]);

  if (profiles.length === 0) {
    return (
      <div className="h-[520px] flex items-center justify-center border border-gray-800 rounded-2xl bg-gray-900">
        <p className="text-gray-500">Выберите профили для отображения спектральных кривых</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
      <h3 className="text-lg font-semibold mb-4">Спектральные кривые отражения</h3>
      <svg ref={svgRef} className="mx-auto"></svg>
      <p className="text-center text-xs text-gray-500 mt-4">
        Усреднённые спектральные кривые по каждому субстрату
      </p>
    </div>
  );
}