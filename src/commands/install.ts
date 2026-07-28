import type { Command } from 'commander'
import { resolveAppBase } from '../lib/config'
import { openBrowser } from '../lib/auth'
import { appLoginUrl } from '../lib/urls'

export function registerInstall(program: Command): void {
  program
    .command('install')
    .description('Open the dashboard sign-in page, where you install Ellipsis')
    .option('--no-browser', 'print the URL without opening a browser (for headless or SSH)')
    .action((opts: { browser?: boolean }) => {
      const url = appLoginUrl(resolveAppBase())
      console.log('To install Ellipsis, open this URL and sign in:')
      console.log(`  ${url}`)
      if (opts.browser !== false) {
        openBrowser(url)
      }
    })
}
