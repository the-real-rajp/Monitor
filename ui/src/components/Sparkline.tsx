/** A 60-point sparkline. Nulls (timeouts) are drawn as red ticks; gaps as nothing. */
export default function Sparkline({
  points,
  width = 120,
  height = 36,
  label = "Last hour of response times",
}: {
  points: (number | null)[] | null;
  width?: number;
  height?: number;
  label?: string;
}) {
  if (!points) {
    return (
      <svg width={width} height={height} role="img" aria-label="No data in the last hour">
        <line
          x1="0"
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="var(--nodata)"
          strokeDasharray="3 3"
        />
      </svg>
    );
  }
  const n = points.length;
  const vals = points.filter((p): p is number => p !== null);
  const max = Math.max(1, ...vals) * 1.25;
  const step = width / Math.max(1, n - 1);
  let d = "";
  let pen = false;
  points.forEach((p, i) => {
    if (p === null) {
      pen = false;
      return;
    }
    const x = i * step;
    const y = height - 3 - (p / max) * (height - 6);
    d += `${pen ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)} `;
    pen = true;
  });
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
    >
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
      {points.map((p, i) =>
        p === null ? (
          <rect
            key={i}
            x={i * step - 1.5}
            y={3}
            width={3}
            height={height - 6}
            rx={1.5}
            fill="var(--danger)"
          />
        ) : null,
      )}
    </svg>
  );
}
