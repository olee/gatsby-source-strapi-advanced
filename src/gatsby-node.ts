import { GatsbyNode, SourceNodesArgs, PluginOptions } from 'gatsby';

import StrapiSourcePlugin from './StrapiSourcePlugin';

export const sourceNodes: GatsbyNode['sourceNodes'] = (sourceArgs: SourceNodesArgs, options: PluginOptions) => {
    const source = new StrapiSourcePlugin(sourceArgs, options);
    return source.sourceNodes();
};

// export function onPostBootstrap() {
//     process.exit();
// }
