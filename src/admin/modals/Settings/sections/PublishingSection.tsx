/**
 * PublishingSection — self-hosted CMS publishing details.
 */
import { useSiteSettingsController } from '../useSiteSettingsController'
import { resolveFrameworkPreferences } from '@core/framework'
import { Switch } from '@ui/components/Switch'
import { SkeletonBlock } from '@ui/components/Skeleton'
import s from '../SettingsModal.module.css'

// Read-only feed URL — same path the publisher bakes to and the live
// route serves. Always /feed.xml; intentionally NOT derived from
// `siteUrl` because the URL is relative and works against the configured
// host at request time.
const RSS_FEED_URL = '/feed.xml'

export function PublishingSection() {
  const { site, error, updateFrameworkPreferences, updateSiteSettings } = useSiteSettingsController()

  if (error) {
    return <p className={s.sectionDescription} role="alert">{error}</p>
  }

  if (!site) {
    return <SkeletonBlock minHeight={200} ariaLabel="Loading site settings" />
  }

  const frameworkPreferences = resolveFrameworkPreferences(site.settings.framework?.preferences)
  const treeShakeId = 'publishing-tree-shake-framework-utilities'
  const enableRssFeedId = 'publishing-enable-rss-feed'

  // Default the toggle to true on first edit; `site.settings.enableRssFeed`
  // is unset for legacy sites that pre-date the field.
  const enableRssFeed = site.settings.enableRssFeed !== false

  return (
    <div>
      <p className={s.sectionDescription}>
        Published pages are served by this self-hosted CMS.
      </p>

      <section aria-labelledby="pub-runtime-heading" className={s.sectionBlock}>
        <h4 id="pub-runtime-heading" className={s.subHeading}>
          Runtime
        </h4>

        <dl className={s.pubRuntimeList}>
          <div>
            <dt>Site</dt>
            <dd>/</dd>
          </div>
          <div>
            <dt>Admin</dt>
            <dd>/admin</dd>
          </div>
          <div>
            <dt>Draft source</dt>
            <dd>Database</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="pub-rss-heading" className={s.sectionBlock}>
        <h4 id="pub-rss-heading" className={s.subHeading}>
          RSS feed
        </h4>

        <div className={s.cardGroup}>
          <div className={s.toggleRow}>
            <div className={s.toggleRowContent}>
              <label htmlFor={enableRssFeedId} className={s.toggleRowLabel}>
                Enable RSS feed
              </label>
              <p className={s.toggleRowDesc}>
                Publish an RSS 2.0 feed of the latest 50 blog posts at
                {' '}
                <a href={RSS_FEED_URL} rel="noopener noreferrer" target="_blank">{RSS_FEED_URL}</a>
                {' '}
                and advertise it via a discovery link in every page&rsquo;s
                <code>&lt;head&gt;</code>. Posts marked <code>noindex</code>
                {' '}or with a future <code>publishedAt</code> are excluded.
                Turning this off stops serving the feed and removes the discovery link.
              </p>
            </div>
            <Switch
              id={enableRssFeedId}
              checked={enableRssFeed}
              onCheckedChange={(value) =>
                updateSiteSettings({ enableRssFeed: value })
              }
            />
          </div>

          <div className={s.toggleRow}>
            <div className={s.toggleRowContent}>
              <span className={s.toggleRowLabel}>Feed URL</span>
              <p className={s.toggleRowDesc}>
                Read-only. Subscribers paste this address into their feed reader.
              </p>
            </div>
            <code
              data-testid="rss-feed-url"
              className={s.pubFeedUrl}
              aria-label="RSS feed URL"
            >
              {RSS_FEED_URL}
            </code>
          </div>
        </div>
      </section>

      <section aria-labelledby="pub-framework-heading" className={s.sectionBlock}>
        <h4 id="pub-framework-heading" className={s.subHeading}>
          Framework CSS
        </h4>

        <div className={s.cardGroup}>
          <div className={s.toggleRow}>
            <div className={s.toggleRowContent}>
              <label htmlFor={treeShakeId} className={s.toggleRowLabel}>
                Tree-shake generated framework utilities
              </label>
              <p className={s.toggleRowDesc}>
                Emit only generated color, typography, and spacing utility classes used in the page
                and component trees. Turn this off when custom runtime code references generated
                utilities outside the editor tree.
              </p>
            </div>
            <Switch
              id={treeShakeId}
              checked={frameworkPreferences.treeShakeGeneratedFrameworkUtilities}
              onCheckedChange={(value) =>
                updateFrameworkPreferences({ treeShakeGeneratedFrameworkUtilities: value })
              }
            />
          </div>
        </div>
      </section>
    </div>
  )
}
