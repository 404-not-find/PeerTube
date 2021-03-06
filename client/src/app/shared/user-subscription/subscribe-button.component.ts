import { Component, Input, OnInit } from '@angular/core'
import { Router } from '@angular/router'
import { AuthService, Notifier } from '@app/core'
import { UserSubscriptionService } from '@app/shared/user-subscription/user-subscription.service'
import { VideoChannel } from '@app/shared/video-channel/video-channel.model'
import { I18n } from '@ngx-translate/i18n-polyfill'
import { VideoService } from '@app/shared/video/video.service'
import { FeedFormat } from '../../../../../shared/models/feeds'

@Component({
  selector: 'my-subscribe-button',
  templateUrl: './subscribe-button.component.html',
  styleUrls: [ './subscribe-button.component.scss' ]
})
export class SubscribeButtonComponent implements OnInit {
  @Input() videoChannel: VideoChannel
  @Input() displayFollowers = false
  @Input() size: 'small' | 'normal' = 'normal'

  subscribed: boolean

  constructor (
    private authService: AuthService,
    private router: Router,
    private notifier: Notifier,
    private userSubscriptionService: UserSubscriptionService,
    private i18n: I18n,
    private videoService: VideoService
  ) { }

  get channelHandle () {
    return this.videoChannel.name + '@' + this.videoChannel.host
  }

  get channelUri () {
    return this.videoChannel.url
  }

  get rssUri () {
    const rssFeed = this.videoService
                      .getVideoChannelFeedUrls(this.videoChannel.id)
                      .find(i => i.format === FeedFormat.RSS)

    return rssFeed.url
  }

  ngOnInit () {
    if (this.isUserLoggedIn()) {
      this.userSubscriptionService.doesSubscriptionExist(this.channelHandle)
        .subscribe(
          res => this.subscribed = res[this.channelHandle],

          err => this.notifier.error(err.message)
        )
    }
  }

  subscribe () {
    if (this.isUserLoggedIn()) {
      return this.localSubscribe()
    }

    return this.gotoLogin()
  }

  localSubscribe () {
    this.userSubscriptionService.addSubscription(this.channelHandle)
      .subscribe(
        () => {
          this.subscribed = true

          this.notifier.success(
            this.i18n('Subscribed to {{nameWithHost}}. You will be notified of all their new videos.',
              { nameWithHost: this.videoChannel.displayName }
            ),
            this.i18n('Subscribed')
          )
        },

          err => this.notifier.error(err.message)
      )
  }

  unsubscribe () {
    if (this.isUserLoggedIn()) {
      this.localUnsubscribe()
    }
  }

  localUnsubscribe () {
    this.userSubscriptionService.deleteSubscription(this.channelHandle)
        .subscribe(
          () => {
            this.subscribed = false

            this.notifier.success(
              this.i18n('Unsubscribed from {{nameWithHost}}', { nameWithHost: this.videoChannel.displayName }),
              this.i18n('Unsubscribed')
            )
          },

          err => this.notifier.error(err.message)
        )
  }

  isUserLoggedIn () {
    return this.authService.isLoggedIn()
  }

  gotoLogin () {
    this.router.navigate([ '/login' ])
  }
}
