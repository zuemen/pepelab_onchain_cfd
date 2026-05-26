interface Props {
  composite: number
  rating:    string
  size?:     'sm' | 'md'
}

export default function ESGBadge({ composite, rating, size = 'sm' }: Props) {
  const color =
    composite >= 80 ? 'bg-emerald-900 text-emerald-300 border-emerald-700' :
    composite >= 60 ? 'bg-lime-900 text-lime-300 border-lime-700'         :
    composite >= 40 ? 'bg-amber-900 text-amber-300 border-amber-700'       :
                      'bg-red-900 text-red-300 border-red-700'

  const pad = size === 'md' ? 'px-2.5 py-1 text-xs' : 'px-2 py-0.5 text-[11px]'

  return (
    <span className={`inline-flex items-center gap-1 rounded-full border font-medium ${color} ${pad}`}>
      <span className="opacity-70">ESG</span>
      <span className="font-bold">{rating}</span>
      <span className="opacity-70">{composite}</span>
    </span>
  )
}
