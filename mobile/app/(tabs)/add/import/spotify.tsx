import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ActivityIndicator, FlatList, Image, Pressable, StyleSheet, Text, View } from 'react-native'

import { useCreateSpotifyImport } from '../../../../src/api/playlistImports'
import { useSpotifyPlaylists, useSpotifyStatus } from '../../../../src/api/spotify'
import { LIKED_SONGS_ID, type SpotifyPlaylist } from '../../../../src/api/types'
import { useTheme, useThemedStyles, type Theme } from '../../../../src/theme'
import { useGuardedRouter } from '../../../../src/navigation/useGuardedRouter'

/**
 * Pick a Spotify playlist to import (#203).
 *
 * The first connected account's, without an account switcher: Spotify's
 * developer mode caps an app at five hand-added users and the owner needs
 * Premium, so "several accounts connected at once on one phone" is a case that
 * cannot really arise. Disconnecting is on the import screen when it does.
 *
 * Starting an import navigates straight to its detail screen. A Spotify import
 * has to fetch and then *match* every track before it can be reviewed, which is
 * minutes for a long playlist — landing back on an unchanged-looking list would
 * give no sign anything had happened.
 */
export default function SpotifyPlaylistsScreen() {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  const theme = useTheme()
  const router = useGuardedRouter()

  const { data: status } = useSpotifyStatus()
  // ⚠️ No `accountId` since #612: it identified a row in the server's
  // `spotify_accounts`, and a device holds exactly one signed-in account.
  const connected = status?.connected ?? false

  const { data, isPending, isError, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSpotifyPlaylists(connected)
  const createImport = useCreateSpotifyImport()

  const playlists = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data])

  const start = (playlist: SpotifyPlaylist) =>
    createImport.mutate(
      { playlistId: playlist.id, name: playlist.name },
      { onSuccess: (created) => router.replace(`/add/import/${created.id}`) },
    )

  // 503 is the backend saying Spotify is not configured, not a failure to
  // answer (ADR-005). Rendering it as an error would tell the user to retry
  // ⚠️ Since #612 "unconfigured" is a property of the *build*, not the server:
  // a 503 cannot happen because nothing is asked of a server. A build with no
  // client id reports it up front, and the section hides itself.
  const unconfigured = status?.configured === false

  if (!connected || unconfigured) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyTitle}>{t('spotify.title')}</Text>
        <Text style={styles.hint}>
          {unconfigured ? t('spotify.notConfiguredShort') : t('spotify.noAccount')}
        </Text>
      </View>
    )
  }

  if (isPending) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
        <Text style={styles.hint}>{t('spotify.loadingPlaylists')}</Text>
      </View>
    )
  }

  if (isError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyTitle}>{t('spotify.loadFailed', { message: error.message })}</Text>
      </View>
    )
  }

  return (
    <View style={styles.container}>
      {createImport.isError ? (
        <View accessibilityRole="alert">
          <Text style={styles.error}>{createImport.error.message}</Text>
        </View>
      ) : null}

      <FlatList
        data={playlists}
        keyExtractor={(playlist) => playlist.id}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => start(item)}
            disabled={createImport.isPending}
            accessibilityRole="button"
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            {item.image_url ? (
              <Image source={{ uri: item.image_url }} style={styles.cover} />
            ) : (
              <View style={[styles.cover, styles.coverEmpty]}>
                {/* Liked Songs has no cover of its own and is not an ordinary
                    playlist — a heart says which one it is without a label. */}
                <Text style={styles.coverGlyph}>{item.id === LIKED_SONGS_ID ? '♥' : '♪'}</Text>
              </View>
            )}
            <View style={styles.rowText}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={styles.rowMeta} numberOfLines={1}>
                {t('spotify.trackCount', { count: item.track_count })}
                {item.owner_name ? ` · ${item.owner_name}` : ''}
              </Text>
            </View>
          </Pressable>
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={
          <View style={styles.centered}>
            <Text style={styles.emptyTitle}>{t('spotify.noPlaylists')}</Text>
          </View>
        }
        ListFooterComponent={
          <>
            {hasNextPage ? (
              <Pressable
                onPress={() => fetchNextPage()}
                disabled={isFetchingNextPage}
                accessibilityRole="button"
                style={({ pressed }) => [styles.more, pressed && styles.pressed]}
              >
                {isFetchingNextPage ? (
                  <ActivityIndicator size="small" color={theme.accentOnSurface} />
                ) : (
                  <Text style={styles.link}>{t('matchReview.loadMore')}</Text>
                )}
              </Pressable>
            ) : null}
            {createImport.isPending ? (
              <View style={styles.more}>
                <ActivityIndicator size="small" color={theme.accentOnSurface} />
              </View>
            ) : null}
          </>
        }
      />
    </View>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
    pressed: { backgroundColor: theme.surfacePressed },
    cover: { width: 48, height: 48, borderRadius: 6, backgroundColor: theme.surfaceMuted },
    coverEmpty: { alignItems: 'center', justifyContent: 'center' },
    coverGlyph: { fontSize: 20, color: theme.textMuted },
    rowText: { flex: 1, minWidth: 0 },
    rowTitle: { fontSize: 15, fontWeight: '500', color: theme.text },
    rowMeta: { fontSize: 12, color: theme.textMuted, marginTop: 2 },
    separator: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
      marginLeft: 12,
    },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6, padding: 24 },
    emptyTitle: { fontSize: 16, fontWeight: '500', color: theme.text, textAlign: 'center' },
    hint: { fontSize: 13, color: theme.textMuted, textAlign: 'center' },
    error: { fontSize: 13, color: theme.danger, padding: 12 },
    more: { paddingVertical: 14, alignItems: 'center' },
    link: { fontSize: 14, color: theme.accentOnSurface },
  })
