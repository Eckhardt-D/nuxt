import { isAbsolute, relative } from 'pathe'
import { genDynamicImport, genExport, genImport } from 'knitwork'
import type { Component, Nuxt, NuxtPluginTemplate, NuxtTemplate } from 'nuxt/schema'

export interface ComponentsTemplateContext {
  nuxt: Nuxt
  options: {
    getComponents: (mode?: 'client' | 'server' | 'all') => Component[]
    mode?: 'client' | 'server'
  }
}

export type ImportMagicCommentsOptions = {
  chunkName: string
  prefetch?: boolean | number
  preload?: boolean | number
}

const createImportMagicComments = (options: ImportMagicCommentsOptions) => {
  const { chunkName, prefetch, preload } = options
  return [
    `webpackChunkName: "${chunkName}"`,
    prefetch === true || typeof prefetch === 'number' ? `webpackPrefetch: ${prefetch}` : false,
    preload === true || typeof preload === 'number' ? `webpackPreload: ${preload}` : false
  ].filter(Boolean).join(', ')
}

const emptyComponentsPlugin = `
import { defineNuxtPlugin } from '#app/nuxt'
export default defineNuxtPlugin({
  name: 'nuxt:global-components',
})
`

export const componentsPluginTemplate: NuxtPluginTemplate<ComponentsTemplateContext> = {
  filename: 'components.plugin.mjs',
  getContents ({ options }) {
    const globalComponents = options.getComponents(options.mode).filter(c => c.global)
    if (!globalComponents.length) { return emptyComponentsPlugin }

    return `import { defineNuxtPlugin } from '#app/nuxt'
import { ${globalComponents.map(c => 'Lazy' + c.pascalName).join(', ')} } from '#global-components'
const lazyGlobalComponents = [
  ${globalComponents.map(c => `["${c.pascalName}", Lazy${c.pascalName}]`).join(',\n')}
]

export default defineNuxtPlugin({
  name: 'nuxt:global-components',
  setup (nuxtApp) {
    for (const [name, component] of lazyGlobalComponents) {
      nuxtApp.vueApp.component(name, component)
      nuxtApp.vueApp.component('Lazy' + name, component)
    }
  }
})
`
  }
}

export const lazyGlobalComponentsTemplate: NuxtTemplate<ComponentsTemplateContext> = {
  getContents ({ options }) {
    const componentExports = options.getComponents(options.mode).filter(c => !c.island && c.global).map((c) => {
      const exp = c.export === 'default' ? 'c.default || c' : `c['${c.export}']`
      const comment = createImportMagicComments(c)

      return `export const Lazy${c.pascalName} = /* #__PURE__ */ defineAsyncComponent(${genDynamicImport(c.filePath, { comment })}.then(c => ${c.mode === 'client' ? `createClientOnly(${exp})` : exp}))`
    })
    return [
      'import { defineAsyncComponent } from \'vue\'',
      ...componentExports
    ].join('\n')
  }
}

export const componentsTemplate: NuxtTemplate<ComponentsTemplateContext> = {
  // components.[server|client].mjs'
  getContents ({ options }) {
    const imports = new Set<string>()
    imports.add('import { defineAsyncComponent } from \'vue\'')

    let num = 0
    const components = options.getComponents(options.mode).filter(c => !c.island).flatMap((c) => {
      const exp = c.export === 'default' ? 'c.default || c' : `c['${c.export}']`
      const comment = createImportMagicComments(c)

      const isClient = c.mode === 'client'
      const definitions = []
      if (isClient) {
        num++
        const identifier = `__nuxt_component_${num}`
        imports.add(genImport('#app/components/client-only', [{ name: 'createClientOnly' }]))
        imports.add(genImport(c.filePath, [{ name: c.export, as: identifier }]))
        definitions.push(`export const ${c.pascalName} = /* #__PURE__ */ createClientOnly(${identifier})`)
      } else {
        definitions.push(genExport(c.filePath, [{ name: c.export, as: c.pascalName }]))
      }
      if (c.global) {
        definitions.push(genExport('#global-components', [{ name: `Lazy${c.pascalName}`, as: c.pascalName }]))
      } else {
        definitions.push(`export const Lazy${c.pascalName} = /* #__PURE__ */ defineAsyncComponent(${genDynamicImport(c.filePath, { comment })}.then(c => ${isClient ? `createClientOnly(${exp})` : exp}))`)
      }
      return definitions
    })
    return [
      ...imports,
      ...components,
      `export const componentNames = ${JSON.stringify(options.getComponents('all').filter(c => !c.island).map(c => c.pascalName))}`
    ].join('\n')
  }
}

export const componentsIslandsTemplate: NuxtTemplate<ComponentsTemplateContext> = {
  // components.islands.mjs'
  getContents ({ options }) {
    const components = options.getComponents()
    const islands = components.filter(component =>
      component.island ||
      // .server components without a corresponding .client component will need to be rendered as an island
      (component.mode === 'server' && !components.some(c => c.pascalName === component.pascalName && c.mode === 'client'))
    )
    return ['import { defineAsyncComponent } from \'vue\'', ...islands.map(
      (c) => {
        const exp = c.export === 'default' ? 'c.default || c' : `c['${c.export}']`
        const comment = createImportMagicComments(c)
        return `export const ${c.pascalName} = /* #__PURE__ */ defineAsyncComponent(${genDynamicImport(c.filePath, { comment })}.then(c => ${exp}))`
      }
    )].join('\n')
  }
}

export const componentsTypeTemplate: NuxtTemplate<ComponentsTemplateContext> = {
  filename: 'components.d.ts',
  getContents: ({ options, nuxt }) => {
    const buildDir = nuxt.options.buildDir
    const componentTypes = options.getComponents().filter(c => !c.island).map(c => [
      c.pascalName,
      `typeof ${genDynamicImport(isAbsolute(c.filePath)
        ? relative(buildDir, c.filePath).replace(/(?<=\w)\.(?!vue)\w+$/g, '')
        : c.filePath.replace(/(?<=\w)\.(?!vue)\w+$/g, ''), { wrapper: false })}['${c.export}']`
    ])

    return `// Generated by components discovery
declare module 'vue' {
  export interface GlobalComponents {
${componentTypes.map(([pascalName, type]) => `    '${pascalName}': ${type}`).join('\n')}
${componentTypes.map(([pascalName, type]) => `    'Lazy${pascalName}': ${type}`).join('\n')}
  }
}

${componentTypes.map(([pascalName, type]) => `export const ${pascalName}: ${type}`).join('\n')}
${componentTypes.map(([pascalName, type]) => `export const Lazy${pascalName}: ${type}`).join('\n')}

export const componentNames: string[]
`
  }
}
