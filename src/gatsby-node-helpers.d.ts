declare module 'gatsby-node-helpers' {

    import { NodeInput } from 'gatsby';
    
    export interface CreateNodeHelpersOptions {
        typePrefix?: string;
    }

    export interface NodeHelpers {
        createNodeFactory(type: string, middleware: (node: NodeInput) => NodeInput): (data: Record<keyof any, any>) => NodeInput;
    }

    export default function createNodeHelpers(options: CreateNodeHelpersOptions): NodeHelpers;

}
