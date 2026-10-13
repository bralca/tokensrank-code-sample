export interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  ariaLabel?: string;
  className?: string;
}

const DEFAULT_COLOR = '#B6FF3C';
const EMPTY_TEXT_COLOR = '#5A6272';

type Point = {
  x: number;
  y: number;
};

function clampDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizePoints(data: number[], width: number, height: number): Point[] {
  const values = data.map((value) => (Number.isFinite(value) ? value : 0));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  const step = width / Math.max(values.length - 1, 1);
  const verticalPadding = 2;
  const drawableHeight = Math.max(height - verticalPadding * 2, 1);

  return values.map((value, index) => {
    const ratio = range === 0 ? 0.5 : (value - min) / range;

    return {
      x: index * step,
      y: height - verticalPadding - ratio * drawableHeight,
    };
  });
}

function buildSmoothPath(points: Point[]): string {
  if (points.length === 0) {
    return '';
  }

  return points.reduce((path, point, index) => {
    if (index === 0) {
      return `M ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
    }

    const previous = points[index - 1];

    if (!previous) {
      return path;
    }

    const controlDistance = (point.x - previous.x) / 2;
    const c1x = previous.x + controlDistance;
    const c2x = point.x - controlDistance;

    return `${path} C ${c1x.toFixed(2)} ${previous.y.toFixed(2)}, ${c2x.toFixed(2)} ${point.y.toFixed(2)}, ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
  }, '');
}

export default function Sparkline({
  data,
  width = 120,
  height = 40,
  color = DEFAULT_COLOR,
  ariaLabel = 'Token usage trend',
  className,
}: SparklineProps) {
  const svgWidth = clampDimension(width, 120);
  const svgHeight = clampDimension(height, 40);

  if (data.length < 2) {
    return (
      <svg
        aria-label="No data"
        className={className}
        data-testid="sparkline-empty"
        height={svgHeight}
        role="img"
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        width={svgWidth}
      >
        <title>No data</title>
        <text
          dominantBaseline="middle"
          fill={EMPTY_TEXT_COLOR}
          fontFamily="Geist Mono, ui-monospace, monospace"
          fontSize="10"
          textAnchor="middle"
          x={svgWidth / 2}
          y={svgHeight / 2}
        >
          No data
        </text>
      </svg>
    );
  }

  const points = normalizePoints(data, svgWidth, svgHeight);
  const path = buildSmoothPath(points);

  return (
    <svg
      aria-label={ariaLabel}
      className={className}
      data-testid="sparkline"
      height={svgHeight}
      role="img"
      viewBox={`0 0 ${svgWidth} ${svgHeight}`}
      width={svgWidth}
    >
      <title>{ariaLabel}</title>
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
