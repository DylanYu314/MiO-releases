import { render } from '@testing-library/react-native'

import { PlayerGlyph, type PlayerGlyphName } from '../src/components/PlayerGlyph'

/**
 * The transport shapes (#326).
 *
 * *"icons for random shuffle and repeat can use the one we used on web,
 * current one we have in app are ass."*
 *
 * **jest performs no layout**, so nothing here can claim an icon *looks* right —
 * that is the S8 device check. What it can pin is the part that silently rots:
 * that the two rewritten glyphs draw real vector paths rather than the rotated
 * `View`s they replaced, that every name in the union renders something, and
 * that `repeat` and `repeat-one` are genuinely different marks rather than the
 * same one with a digit stacked on it.
 */

type Node = { type?: string; props?: Record<string, unknown>; children?: Node[] } | string | null

/** Every `d` attribute in the rendered tree, in order.
 *
 *  Walks the JSON rather than querying by component type: the host element
 *  react-native-svg renders is an implementation detail of that library, and a
 *  test naming it would break on an upgrade that changed nothing we care about.
 *  A `d` attribute is the path data itself. */
function collectPaths(node: Node, found: string[] = []): string[] {
  if (!node || typeof node === 'string') return found
  const d = node.props?.d
  if (typeof d === 'string') found.push(d)
  for (const child of node.children ?? []) collectPaths(child, found)
  return found
}

async function pathsOf(name: PlayerGlyphName): Promise<string[]> {
  const tree = await render(<PlayerGlyph name={name} color="#fff" size={24} />)
  return collectPaths(tree.toJSON() as Node)
}

describe('PlayerGlyph', () => {
  it.each<PlayerGlyphName>([
    'play',
    'pause',
    'next',
    'previous',
    'shuffle',
    'repeat',
    'repeat-one',
  ])('renders %s', async (name) => {
    // Every arm of the union: a missing `case` returns undefined, which React
    // renders as nothing at all rather than failing.
    const tree = await render(<PlayerGlyph name={name} color="#fff" size={24} />)
    expect(tree.toJSON()).not.toBeNull()
  })

  it.each<PlayerGlyphName>(['shuffle', 'repeat', 'repeat-one'])(
    'draws %s as vector paths, not stacked views',
    async (name) => {
      expect((await pathsOf(name)).length).toBeGreaterThan(0)
    },
  )

  it('leaves the simple transport shapes as plain views', async () => {
    // Deliberately unchanged by #326: triangles and rectangles are drawn
    // exactly by a `View`, and the playing panel is not a surface to redesign
    // beyond what was asked for.
    expect(await pathsOf('play')).toEqual([])
    expect(await pathsOf('pause')).toEqual([])
  })

  it('draws repeat-one as repeat plus the digit lucide puts inside it', async () => {
    const repeat = await pathsOf('repeat')
    const one = await pathsOf('repeat-one')

    // Not the same mark: the panel used to overlay a text "1" on a ring, which
    // is what this replaces.
    expect(one).not.toEqual(repeat)
    expect(one).toEqual([...repeat, 'M11 10h1v4'])
  })
})
