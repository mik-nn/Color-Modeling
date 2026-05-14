// src/components/LabScatterPlot.tsx
import { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { ProfileData } from '../types';

interface LabScatterPlotProps {
  profiles: ProfileData[];
  width?: number;
  height?: number;
}

export default function LabScatterPlot({ 
  profiles, 
  width = 700, 
  height = 600 
}: LabScatterPlotProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!svgRef.current || profiles.length === 0) return;

    // Очистка предыдущего графика
    d3.select(svgRef.current).selectAll("*").remove();

    const margin = { top: 40, right: 40, bottom: 60, left: 60 };
    const w = width - margin.left - margin.right;
    const h = height - margin.top - margin.bottom;

    const svg = d3.select(svgRef.current)
      .attr("width", width)
      .attr("height", height)
      .append("g")
      .attr("transform", `translate(${margin.left},${margin.top})`);

    // Собираем все точки
    const allPoints: Array<{
      L: number;
      a: number;
      b: number;
      substrate: string;
      color: string;
    }> = [];

    const colors = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b'];

    profiles.forEach((profile, index) => {
      profile.raw.forEach(patch => {
        allPoints.push({
          L: patch.LAB_L,
          a: patch.LAB_A,
          b: patch.LAB_B,
          substrate: profile.metadata.substrate,
          color: colors[index % colors.length]
        });
      });
    });

    // Масштабы
    const xScale = d3.scaleLinear()
      .domain([-40, 40])           // a* axis
      .range([0, w]);

    const yScale = d3.scaleLinear()
      .domain([100, 0])            // L* axis (перевёрнутый)
      .range([0, h]);

    // Оси
    const xAxis = d3.axisBottom(xScale).ticks(9);
    const yAxis = d3.axisLeft(yScale).ticks(10);

    svg.append("g")
      .attr("transform", `translate(0,${h})`)
      .call(xAxis);

    svg.append("g")
      .call(yAxis);

    // Подписи осей
    svg.append("text")
      .attr("x", w / 2)
      .attr("y", h + 45)
      .attr("text-anchor", "middle")
      .attr("fill", "#9ca3af")
      .text("a* (зелёный ← → красный)");

    svg.append("text")
      .attr("transform", "rotate(-90)")
      .attr("x", -h / 2)
      .attr("y", -45)
      .attr("text-anchor", "middle")
      .attr("fill", "#9ca3af")
      .text("L* (светлота)");

    // Точки
    svg.selectAll("circle")
      .data(allPoints)
      .enter()
      .append("circle")
      .attr("cx", d => xScale(d.a))
      .attr("cy", d => yScale(d.L))
      .attr("r", 3.5)
      .attr("fill", d => d.color)
      .attr("fill-opacity", 0.65)
      .attr("stroke", "#111827")
      .attr("stroke-width", 0.5);

    // Легенда
    const legend = svg.append("g")
      .attr("transform", `translate(${w - 140}, 20)`);

    profiles.forEach((profile, i) => {
      const g = legend.append("g")
        .attr("transform", `translate(0, ${i * 24})`);

      g.append("circle")
        .attr("cx", 8)
        .attr("cy", 8)
        .attr("r", 6)
        .attr("fill", colors[i % colors.length]);

      g.append("text")
        .attr("x", 22)
        .attr("y", 12)
        .attr("fill", "#e5e7eb")
        .attr("font-size", "13px")
        .text(profile.metadata.substrate);
    });

  }, [profiles, width, height]);

  if (profiles.length === 0) {
    return (
      <div className="h-[600px] flex items-center justify-center border border-gray-800 rounded-2xl bg-gray-900">
        <p className="text-gray-500">Выберите профили для отображения графика CIELAB</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
      <h3 className="text-lg font-semibold mb-4">CIELAB Color Space Distribution</h3>
      <svg ref={svgRef} className="mx-auto"></svg>
      <p className="text-center text-xs text-gray-500 mt-3">
        Сравнение распределения цветов в пространстве CIELAB
      </p>
    </div>
  );
}