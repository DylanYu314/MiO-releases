import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Pagination } from './Pagination'

describe('Pagination', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('advances the offset and scrolls to the top on Next', async () => {
    const scrollTo = vi.fn()
    vi.stubGlobal('scrollTo', scrollTo)
    const onOffsetChange = vi.fn()

    render(<Pagination total={100} limit={20} offset={0} onOffsetChange={onOffsetChange} />)
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))

    expect(onOffsetChange).toHaveBeenCalledWith(20)
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }))
  })

  it('disables Previous on the first page and renders nothing when empty', () => {
    const { rerender } = render(
      <Pagination total={100} limit={20} offset={0} onOffsetChange={() => {}} />,
    )
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()

    rerender(<Pagination total={0} limit={20} offset={0} onOffsetChange={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Previous' })).not.toBeInTheDocument()
  })
})
