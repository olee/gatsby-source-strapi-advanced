import { SourceNodesArgs } from 'gatsby';

import StrapiSourcePlugin, { StrapiPluginOptions } from '../src/StrapiSourcePlugin';

const sourceArgs: SourceNodesArgs = {
    boundActionCreators: {
        createNode: (...args: any[]) => console.log(...args),
        touchNode: (...args: any[]) => console.log(...args),
    } as any,
    reporter: {
        panic: (...args: any[]) => console.log(...args),
        info: (...args: any[]) => console.log(...args),
        activityTimer: () => ({
            start: () => null,
            end: () => null,
        }) as any,
    } as any,
    cache: {
        get: () => undefined,
    } as any,
    createNodeId: () => String(Math.random()),
} as any;

const options: StrapiPluginOptions = {
};

const plugin = new StrapiSourcePlugin(sourceArgs, options);

(async () => {
    plugin.sourceNodes();
})();
