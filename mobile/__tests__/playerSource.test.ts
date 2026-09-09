import type { Song } from '../src/api/types'
import { __resetInstallId, loadInstallId } from '../src/api/installId'
import { artworkUrlFor, audioSourceFor, lockScreenMetadata } from '../src/player/source'

const SONG: Song = {
  id: 42,
  title: 'A Song',
  artist: 'An Artist',
  album: 'An Album',
  duration: 200,
  source_url: 'https://example.com/42',
  source_platform: 'youtube',
  added_at: '2026-07-25T00:00:00Z',
  loudness_lufs: null,
  peak_dbfs: null,
}

describe('audioSourceFor', () => {
  beforeEach(() => {
    __resetInstallId()
  })

  it('points at the song audio endpoint', () => {
    expect(audioSourceFor(SONG, 'http://192.168.1.143:8000', null)).toEqual({
      uri: 'http://192.168.1.143:8000/songs/42/audio',
      headers: undefined,
    })
  })

  it('sends the access key, or the key holder cannot stream their own songs', () => {
    expect(audioSourceFor(SONG, 'http://host:8000', 'secret-key')?.headers).toEqual({
      'X-Unlock-Key': 'secret-key',
    })
  })

  it('sends the install id, without which our own song 404s', async () => {
    // The stream is scoped by owner since #170, so the audio request has to
    // identify the install just as an API call does — and expo-audio forwarding
    // `headers` is what makes that possible at all.
    await loadInstallId()

    const headers = audioSourceFor(SONG, 'http://host:8000', null)?.headers

    expect(headers?.['X-Install-Id']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('plays the local file when the audio is on this device (#217)', () => {
    const source = audioSourceFor(SONG, 'https://mio.test/api', 'a-key', 'file:///library/ab.opus')

    // The claim local-first exists to make: no server, no network, no headers.
    // Playable on a train, in a lift, and after the server has gone away.
    expect(source?.uri).toBe('file:///library/ab.opus')
    expect(source?.headers).toBeUndefined()
  })

  it('prefers the local file even when a server is configured', () => {
    const source = audioSourceFor(SONG, 'https://mio.test/api', 'a-key', 'file:///library/ab.opus')

    // Streaming what is already on disk is slower and can 404; the file cannot.
    expect(source?.uri).not.toContain('mio.test')
  })

  it('plays a local file with no server configured at all', () => {
    // The offline case in full — nothing to stream from, and nothing needed.
    expect(audioSourceFor(SONG, null, null, 'file:///library/ab.opus')?.uri).toBe(
      'file:///library/ab.opus',
    )
  })

  it('streams when the row exists but its bytes do not', () => {
    // A real state the schema models: metadata arrives before the download, or
    // the download failed. Falling back is what keeps that song playable.
    expect(audioSourceFor(SONG, 'https://mio.test/api', null, null)?.uri).toContain('mio.test')
  })

  it('has nothing to play without a server', () => {
    expect(audioSourceFor(SONG, null, null)).toBeNull()
  })
})

describe('artworkUrlFor', () => {
  it('is always omitted, because the OS fetches artwork without our headers', () => {
    // Before #170 this worked for the unowned library, which needed no
    // identification. Every row now has an owner, so an unauthenticated fetch of
    // /cover 404s and Android draws a blank tile either way — returning a URL
    // that cannot work would only add a pointless request.
    expect(artworkUrlFor()).toBeUndefined()
  })
})

describe('lockScreenMetadata', () => {
  it('carries what Android draws on the lock screen', () => {
    expect(lockScreenMetadata(SONG, 'http://host:8000/songs/42/cover')).toEqual({
      title: 'A Song',
      artist: 'An Artist',
      albumTitle: 'An Album',
      artworkUrl: 'http://host:8000/songs/42/cover',
    })
  })

  it('turns a null album into undefined rather than passing null to the OS', () => {
    expect(lockScreenMetadata({ ...SONG, album: null }).albumTitle).toBeUndefined()
  })
})
