import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const sdk = JSON.parse(readFileSync(new URL('../node_modules/@ellipsis-dev/sdk/package.json', import.meta.url), 'utf8'))
const match = /^2\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(pkg.version)
if (!match) throw new Error('CLI version must be 2.X.Y')

const expectedSdk = `0.${match[1]}.${match[2]}`
if (pkg.dependencies['@ellipsis-dev/sdk'] !== expectedSdk || sdk.version !== expectedSdk) {
  throw new Error(`CLI ${pkg.version} requires SDK ${expectedSdk}, pinned exactly and installed`)
}

const releaseVersion = process.argv[2]
if (releaseVersion !== undefined && releaseVersion !== pkg.version) {
  throw new Error(`Release version ${releaseVersion} must match package.json version ${pkg.version}`)
}

console.log(`CLI ${pkg.version} / SDK ${sdk.version}`)
