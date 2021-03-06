import { bufferTime, catchError, filter, map, share, switchMap, tap } from 'rxjs/operators'
import { Injectable } from '@angular/core'
import { merge, Observable, of, ReplaySubject, Subject } from 'rxjs'
import { RestExtractor } from '../rest/rest-extractor.service'
import { HttpClient, HttpParams } from '@angular/common/http'
import { ResultList, VideoPlaylistElementCreate, VideoPlaylistElementUpdate } from '../../../../../shared'
import { environment } from '../../../environments/environment'
import { VideoPlaylist as VideoPlaylistServerModel } from '@shared/models/videos/playlist/video-playlist.model'
import { VideoChannelService } from '@app/shared/video-channel/video-channel.service'
import { VideoChannel } from '@app/shared/video-channel/video-channel.model'
import { VideoPlaylistCreate } from '@shared/models/videos/playlist/video-playlist-create.model'
import { VideoPlaylistUpdate } from '@shared/models/videos/playlist/video-playlist-update.model'
import { objectToFormData } from '@app/shared/misc/utils'
import { AuthUser, ServerService } from '@app/core'
import { VideoPlaylist } from '@app/shared/video-playlist/video-playlist.model'
import { AccountService } from '@app/shared/account/account.service'
import { Account } from '@app/shared/account/account.model'
import { RestService } from '@app/shared/rest'
import { VideoExistInPlaylist, VideosExistInPlaylists } from '@shared/models/videos/playlist/video-exist-in-playlist.model'
import { VideoPlaylistReorder } from '@shared/models/videos/playlist/video-playlist-reorder.model'
import { ComponentPaginationLight } from '@app/shared/rest/component-pagination.model'
import { VideoPlaylistElement as ServerVideoPlaylistElement } from '@shared/models/videos/playlist/video-playlist-element.model'
import { VideoPlaylistElement } from '@app/shared/video-playlist/video-playlist-element.model'
import { uniq } from 'lodash-es'
import * as debug from 'debug'

const logger = debug('peertube:playlists:VideoPlaylistService')

export type CachedPlaylist = VideoPlaylist | { id: number, displayName: string }

@Injectable()
export class VideoPlaylistService {
  static BASE_VIDEO_PLAYLIST_URL = environment.apiUrl + '/api/v1/video-playlists/'
  static MY_VIDEO_PLAYLIST_URL = environment.apiUrl + '/api/v1/users/me/video-playlists/'

  // Use a replay subject because we "next" a value before subscribing
  private videoExistsInPlaylistNotifier = new ReplaySubject<number>(1)
  private videoExistsInPlaylistCacheSubject = new Subject<VideosExistInPlaylists>()
  private readonly videoExistsInPlaylistObservable: Observable<VideosExistInPlaylists>

  private videoExistsObservableCache: { [ id: number ]: Observable<VideoExistInPlaylist[]> } = {}
  private videoExistsCache: { [ id: number ]: VideoExistInPlaylist[] } = {}

  private myAccountPlaylistCache: ResultList<CachedPlaylist> = undefined
  private myAccountPlaylistCacheSubject = new Subject<ResultList<CachedPlaylist>>()

  constructor (
    private authHttp: HttpClient,
    private serverService: ServerService,
    private restExtractor: RestExtractor,
    private restService: RestService
  ) {
    this.videoExistsInPlaylistObservable = merge(
      this.videoExistsInPlaylistNotifier.pipe(
        bufferTime(500),
        filter(videoIds => videoIds.length !== 0),
        map(videoIds => uniq(videoIds)),
        switchMap(videoIds => this.doVideosExistInPlaylist(videoIds)),
        share()
      ),

      this.videoExistsInPlaylistCacheSubject
    )
  }

  listChannelPlaylists (videoChannel: VideoChannel, componentPagination: ComponentPaginationLight): Observable<ResultList<VideoPlaylist>> {
    const url = VideoChannelService.BASE_VIDEO_CHANNEL_URL + videoChannel.nameWithHost + '/video-playlists'
    const pagination = this.restService.componentPaginationToRestPagination(componentPagination)

    let params = new HttpParams()
    params = this.restService.addRestGetParams(params, pagination)

    return this.authHttp.get<ResultList<VideoPlaylist>>(url, { params })
               .pipe(
                 switchMap(res => this.extractPlaylists(res)),
                 catchError(err => this.restExtractor.handleError(err))
               )
  }

  listMyPlaylistWithCache (user: AuthUser, search?: string) {
    if (!search && this.myAccountPlaylistCache) return of(this.myAccountPlaylistCache)

    return this.listAccountPlaylists(user.account, undefined, '-updatedAt', search)
               .pipe(
                 tap(result => {
                   if (!search) this.myAccountPlaylistCache = result
                 })
               )
  }

  listAccountPlaylists (
    account: Account,
    componentPagination: ComponentPaginationLight,
    sort: string,
    search?: string
  ): Observable<ResultList<VideoPlaylist>> {
    const url = AccountService.BASE_ACCOUNT_URL + account.nameWithHost + '/video-playlists'
    const pagination = componentPagination
      ? this.restService.componentPaginationToRestPagination(componentPagination)
      : undefined

    let params = new HttpParams()
    params = this.restService.addRestGetParams(params, pagination, sort)
    if (search) params = this.restService.addObjectParams(params, { search })

    return this.authHttp.get<ResultList<VideoPlaylist>>(url, { params })
               .pipe(
                 switchMap(res => this.extractPlaylists(res)),
                 catchError(err => this.restExtractor.handleError(err))
               )
  }

  getVideoPlaylist (id: string | number) {
    const url = VideoPlaylistService.BASE_VIDEO_PLAYLIST_URL + id

    return this.authHttp.get<VideoPlaylist>(url)
               .pipe(
                 switchMap(res => this.extractPlaylist(res)),
                 catchError(err => this.restExtractor.handleError(err))
               )
  }

  createVideoPlaylist (body: VideoPlaylistCreate) {
    const data = objectToFormData(body)

    return this.authHttp.post<{ videoPlaylist: { id: number } }>(VideoPlaylistService.BASE_VIDEO_PLAYLIST_URL, data)
               .pipe(
                 tap(res => {
                   this.myAccountPlaylistCache.total++

                   this.myAccountPlaylistCache.data.push({
                     id: res.videoPlaylist.id,
                     displayName: body.displayName
                   })

                   this.myAccountPlaylistCacheSubject.next(this.myAccountPlaylistCache)
                 }),
                 catchError(err => this.restExtractor.handleError(err))
               )
  }

  updateVideoPlaylist (videoPlaylist: VideoPlaylist, body: VideoPlaylistUpdate) {
    const data = objectToFormData(body)

    return this.authHttp.put(VideoPlaylistService.BASE_VIDEO_PLAYLIST_URL + videoPlaylist.id, data)
               .pipe(
                 map(this.restExtractor.extractDataBool),
                 tap(() => {
                   const playlist = this.myAccountPlaylistCache.data.find(p => p.id === videoPlaylist.id)
                   playlist.displayName = body.displayName

                   this.myAccountPlaylistCacheSubject.next(this.myAccountPlaylistCache)
                 }),
                 catchError(err => this.restExtractor.handleError(err))
               )
  }

  removeVideoPlaylist (videoPlaylist: VideoPlaylist) {
    return this.authHttp.delete(VideoPlaylistService.BASE_VIDEO_PLAYLIST_URL + videoPlaylist.id)
               .pipe(
                 map(this.restExtractor.extractDataBool),
                 tap(() => {
                   this.myAccountPlaylistCache.total--
                   this.myAccountPlaylistCache.data = this.myAccountPlaylistCache.data
                                                          .filter(p => p.id !== videoPlaylist.id)

                   this.myAccountPlaylistCacheSubject.next(this.myAccountPlaylistCache)
                 }),
                 catchError(err => this.restExtractor.handleError(err))
               )
  }

  addVideoInPlaylist (playlistId: number, body: VideoPlaylistElementCreate) {
    const url = VideoPlaylistService.BASE_VIDEO_PLAYLIST_URL + playlistId + '/videos'

    return this.authHttp.post<{ videoPlaylistElement: { id: number } }>(url, body)
               .pipe(
                 tap(res => {
                   const existsResult = this.videoExistsCache[body.videoId]
                   existsResult.push({
                     playlistId,
                     playlistElementId: res.videoPlaylistElement.id,
                     startTimestamp: body.startTimestamp,
                     stopTimestamp: body.stopTimestamp
                   })

                   this.runPlaylistCheck(body.videoId)
                 }),
                 catchError(err => this.restExtractor.handleError(err))
               )
  }

  updateVideoOfPlaylist (playlistId: number, playlistElementId: number, body: VideoPlaylistElementUpdate, videoId: number) {
    return this.authHttp.put(VideoPlaylistService.BASE_VIDEO_PLAYLIST_URL + playlistId + '/videos/' + playlistElementId, body)
               .pipe(
                 map(this.restExtractor.extractDataBool),
                 tap(() => {
                   const existsResult = this.videoExistsCache[videoId]
                   const elem = existsResult.find(e => e.playlistElementId === playlistElementId)

                   elem.startTimestamp = body.startTimestamp
                   elem.stopTimestamp = body.stopTimestamp

                   this.runPlaylistCheck(videoId)
                 }),
                 catchError(err => this.restExtractor.handleError(err))
               )
  }

  removeVideoFromPlaylist (playlistId: number, playlistElementId: number, videoId?: number) {
    return this.authHttp.delete(VideoPlaylistService.BASE_VIDEO_PLAYLIST_URL + playlistId + '/videos/' + playlistElementId)
               .pipe(
                 map(this.restExtractor.extractDataBool),
                 tap(() => {
                   if (!videoId) return

                   this.videoExistsCache[videoId] = this.videoExistsCache[videoId].filter(e => e.playlistElementId !== playlistElementId)
                   this.runPlaylistCheck(videoId)
                 }),
                 catchError(err => this.restExtractor.handleError(err))
               )
  }

  reorderPlaylist (playlistId: number, oldPosition: number, newPosition: number) {
    const body: VideoPlaylistReorder = {
      startPosition: oldPosition,
      insertAfterPosition: newPosition
    }

    return this.authHttp.post(VideoPlaylistService.BASE_VIDEO_PLAYLIST_URL + playlistId + '/videos/reorder', body)
               .pipe(
                 map(this.restExtractor.extractDataBool),
                 catchError(err => this.restExtractor.handleError(err))
               )
  }

  getPlaylistVideos (
    videoPlaylistId: number | string,
    componentPagination: ComponentPaginationLight
  ): Observable<ResultList<VideoPlaylistElement>> {
    const path = VideoPlaylistService.BASE_VIDEO_PLAYLIST_URL + videoPlaylistId + '/videos'
    const pagination = this.restService.componentPaginationToRestPagination(componentPagination)

    let params = new HttpParams()
    params = this.restService.addRestGetParams(params, pagination)

    return this.authHttp
               .get<ResultList<ServerVideoPlaylistElement>>(path, { params })
               .pipe(
                 switchMap(res => this.extractVideoPlaylistElements(res)),
                 catchError(err => this.restExtractor.handleError(err))
               )
  }

  listenToMyAccountPlaylistsChange () {
    return this.myAccountPlaylistCacheSubject.asObservable()
  }

  listenToVideoPlaylistChange (videoId: number) {
    if (this.videoExistsObservableCache[ videoId ]) {
      return this.videoExistsObservableCache[ videoId ]
    }

    const obs = this.videoExistsInPlaylistObservable
                    .pipe(
                      map(existsResult => existsResult[ videoId ]),
                      filter(r => !!r),
                      tap(result => this.videoExistsCache[ videoId ] = result)
                    )

    this.videoExistsObservableCache[ videoId ] = obs
    return obs
  }

  runPlaylistCheck (videoId: number) {
    logger('Running playlist check.')

    if (this.videoExistsCache[videoId]) {
      logger('Found cache for %d.', videoId)

      return this.videoExistsInPlaylistCacheSubject.next({ [videoId]: this.videoExistsCache[videoId] })
    }

    logger('Fetching from network for %d.', videoId)
    return this.videoExistsInPlaylistNotifier.next(videoId)
  }

  extractPlaylists (result: ResultList<VideoPlaylistServerModel>) {
    return this.serverService.getServerLocale()
               .pipe(
                 map(translations => {
                   const playlistsJSON = result.data
                   const total = result.total
                   const playlists: VideoPlaylist[] = []

                   for (const playlistJSON of playlistsJSON) {
                     playlists.push(new VideoPlaylist(playlistJSON, translations))
                   }

                   return { data: playlists, total }
                 })
               )
  }

  extractPlaylist (playlist: VideoPlaylistServerModel) {
    return this.serverService.getServerLocale()
               .pipe(map(translations => new VideoPlaylist(playlist, translations)))
  }

  extractVideoPlaylistElements (result: ResultList<ServerVideoPlaylistElement>) {
    return this.serverService.getServerLocale()
               .pipe(
                 map(translations => {
                   const elementsJson = result.data
                   const total = result.total
                   const elements: VideoPlaylistElement[] = []

                   for (const elementJson of elementsJson) {
                     elements.push(new VideoPlaylistElement(elementJson, translations))
                   }

                   return { total, data: elements }
                 })
               )
  }

  private doVideosExistInPlaylist (videoIds: number[]): Observable<VideosExistInPlaylists> {
    const url = VideoPlaylistService.MY_VIDEO_PLAYLIST_URL + 'videos-exist'

    let params = new HttpParams()
    params = this.restService.addObjectParams(params, { videoIds })

    return this.authHttp.get<VideoExistInPlaylist>(url, { params, headers: { ignoreLoadingBar: '' } })
               .pipe(catchError(err => this.restExtractor.handleError(err)))
  }
}
