import { describe, it, expect } from 'vitest'

import { screenApplication } from './kycScreening'

describe('screenApplication', () => {
  it('is clean for an ordinary name and a listed nationality', () => {
    const result = screenApplication({ fullName: '路人甲', nationality: 'TW' })
    expect(result.verdict).toBe('clean')
    expect(result.reasons).toEqual([])
  })

  it('flags OTHER nationality as unclear jurisdiction', () => {
    const result = screenApplication({ fullName: '路人甲', nationality: 'OTHER' })
    expect(result.verdict).toBe('needsReview')
    expect(result.reasons).toContain('unclearJurisdiction')
  })

  it('flags an exact (case/whitespace-insensitive) watchlist name match', () => {
    const result = screenApplication({ fullName: '  walter   WHITE ', nationality: 'US' })
    expect(result.verdict).toBe('needsReview')
    expect(result.reasons).toContain('watchlistNameMatch')
  })

  it('does not flag a name that merely contains a watchlist name as a substring', () => {
    const result = screenApplication({ fullName: 'Walter White Jr.', nationality: 'US' })
    expect(result.verdict).toBe('clean')
  })

  it('can carry both reasons at once', () => {
    const result = screenApplication({ fullName: 'Tony Soprano', nationality: 'OTHER' })
    expect(result.verdict).toBe('needsReview')
    expect(result.reasons).toEqual(
      expect.arrayContaining(['unclearJurisdiction', 'watchlistNameMatch']),
    )
    expect(result.reasons).toHaveLength(2)
  })
})
