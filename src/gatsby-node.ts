import { SourceNodesArgs, PluginOptions, CreateSchemaCustomizationArgs } from 'gatsby';

import StrapiSourcePlugin from './StrapiSourcePlugin';

let plugin: StrapiSourcePlugin;

export function sourceNodes(args: SourceNodesArgs, options: PluginOptions) {
    if (!plugin)
        plugin = new StrapiSourcePlugin(args, options);
    return plugin.sourceNodes();
}

export function createSchemaCustomization(args: CreateSchemaCustomizationArgs, options: PluginOptions) {
    if (!plugin)
        plugin = new StrapiSourcePlugin(args, options);
    return plugin.createSchemaCustomization(args);
}
