// src/components/LabScatterPlot.tsx
import { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { ProfileData } from '../types';

interface LabScatterPlotProps {
  profiles: ProfileData[];
}

export default function LabScatterPlot({ profiles }: LabScatterPlotProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(700);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(entries => {
      setContainerWidth(Math.floor(entries[0].contentRect.width));
    });
    ro.observe(containerRef.current);
    setContainerWidth(Math.floor(containerRef.current.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);

  const width = containerWidth;
  const height = Math.round(width * 0.75);

  useEffect(() => {
    if (!svgRef.current || profiles.length === 0 || width < 100) return;

    d3.select(svgRef.current).selectAll('*').remove();

    const margin = { top: 40, right: 40, bottom: 60, left: 60 };
    const w = width - margin.left - margin.right;
    const h = height - margin.top - margin.bottom;

    const svg = d3.select(svgRef.current)
      .attr('width', width)
      .attr('height', height)
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    const colors = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b'];

    const allPoints: { L: number; a: number; b: number; substrate: string; color: string }[] = [];
    profiles.forEach((profile, index) => {
      profile.raw.forEach(patch => {
        allPoints.push({ L: patch.LAB_L, a: patch.LAB_A, b: patch.LAB_B, substrate: profile.metadata.substrate, color: colors[index % colors.length] });
      });
    });

    const xScale = d3.scaleLinear().domain([-40, 40]).range([0, w]);
    const yScale = d3.scaleLinear().domain([100, 0]).range([0, h]);

    svg.append('g').attr('transform', `translate(0,${h})`).call(d3.axisBottom(xScale).ticks(9));
    svg.append('g').call(d3.axisLeft(yScale).ticks(10));

    svg.append('text').attr('x', w / 2).attr('y', h + 45).attr('text-anchor', 'middle').attr('fill', '#9ca3af').text('a* (green ← → red)');
    svg.append('text').attr('transform', 'rotate(-90)').attr('x', -h / 2).attr('y', -45).attr('text-anchor', 'middle').attr('fill', '#9ca3af').text('L* (lightness)');

    svg.selectAll('circle').data(allPoints).enter().append('circle')
      .attr('cx', d => xScale(d.a))
      .attr('cy', d => yScale(d.L))
      .attr('r', 3.5)
      .attr('fill', d => d.color)
      .attr('fill-opacity', 0.65)
      .attr('stroke', '#111827')
      .attr('stroke-width', 0.5);

    const legend = svg.append('g').attr('transform', `translate(${w - 140}, 20)`);
    profiles.forEach((profile, i) => {
      const g = legend.append('g').attr('transform', `translate(0, ${i * 24})`);
      g.append('circle').attr('cx', 8).attr('cy', 8).attr('r', 6).attr('fill', colors[i % colors.length]);
      g.append('text').attr('x', 22).attr('y', 12).attr('fill', '#e5e7eb').attr('font-size', '13px').text(profile.metadata.substrate);
    });
  }, [profiles, width, height]);

  if (profiles.length === 0) {
    return (
      <div ref={containerRef} className="h-64 flex items-center justify-center border border-gray-800 rounded-2xl bg-gray-900">
        <p className="text-gray-500">Select profiles to show the CIELAB distribution</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
      <h3 className="text-lg font-semibold mb-4">CIELAB Color Space Distribution</h3>
      <svg ref={svgRef} className="mx-auto block" />
      <p className="text-center text-xs text-gray-500 mt-3">
        Color distribution comparison across substrates in CIELAB
      </p>
    </div>
  );
}
