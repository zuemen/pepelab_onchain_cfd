interface Props {
  title:       string
  value:       string
  sub?:        string
  valueClass?: string
}

export default function StatCard({ title, value, sub, valueClass = 'text-white' }: Props) {
  return (
    <div className="rounded-card border border-surface-border bg-surface shadow-card p-5 space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{title}</p>
      <p className={`text-2xl font-bold font-mono ${valueClass}`}>{value}</p>
      {sub && <p className="text-xs text-gray-500">{sub}</p>}
    </div>
  )
}
