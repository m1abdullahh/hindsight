interface SparklineProps {
  data: number[];
  color?: string;
  fill?: string;
  width?: number;
  height?: number;
  strokeWidth?: number;
}

export function Sparkline({
  data,
  color = 'currentColor',
  fill,
  width = 60,
  height = 26,
  strokeWidth = 1.4,
}: SparklineProps) {
  if (data.length === 0) {
    return <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} />;
  }
  const max = Math.max(...data, 1);
  const denom = Math.max(data.length - 1, 1);
  const pts = data
    .map((v, i) => `${(i / denom) * width},${height - (v / max) * (height - 2) - 1}`)
    .join(' ');
  const area = `M0,${height} L${pts} L${width},${height} Z`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="block">
      {fill && <path d={area} fill={fill} />}
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
