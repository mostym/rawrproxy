const { ApolloServer } = require('apollo-server-express');
const { makeExecutableSchema } = require('@graphql-tools/schema');
const { stitchSchemas } = require('@graphql-tools/stitch');
const { introspectSchema, wrapSchema } = require('@graphql-tools/wrap');
const { GraphQLSchema, print } = require('graphql');
const { PubSub } = require('graphql-subscriptions');
const fetch = require('axios');
const Logger = require('../utils/Logger');

class GraphQLProxy {
    constructor(options = {}) {
        this.logger = new Logger();
        this.services = new Map();
        this.schemas = new Map();
        this.stitchedSchema = null;
        
        // Configuration
        this.config = {
            playground: options.playground !== false,
            introspection: options.introspection !== false,
            federation: options.federation || false,
            caching: options.caching !== false,
            subscriptions: options.subscriptions !== false,
            depthLimit: options.depthLimit || 10,
            costLimit: options.costLimit || 1000,
            rateLimit: options.rateLimit || null
        };
        
        // PubSub for subscriptions
        this.pubsub = new PubSub();
        
        // Query complexity analyzer
        this.complexityAnalyzer = options.complexityAnalyzer || this.defaultComplexityAnalyzer;
        
        // Statistics
        this.stats = {
            queries: 0,
            mutations: 0,
            subscriptions: 0,
            errors: 0,
            cacheHits: 0,
            cacheMisses: 0
        };
        
        this.logger.info('GraphQL proxy initialized');
    }

    // Register a GraphQL service
    async registerService(config) {
        const service = {
            name: config.name,
            url: config.url,
            headers: config.headers || {},
            
            // Schema configuration
            namespace: config.namespace || config.name,
            transforms: config.transforms || [],
            
            // Federation config
            federationConfig: config.federationConfig || null,
            
            // Caching
            cacheConfig: config.cacheConfig || {
                ttl: 60,
                scope: 'PUBLIC'
            },
            
            // Rate limiting
            rateLimit: config.rateLimit || null,
            
            // Health check
            healthCheck: config.healthCheck || '/health',
            
            // Retry configuration
            retries: config.retries || 3,
            timeout: config.timeout || 30000
        };
        
        try {
            // Introspect remote schema
            const schema = await this.introspectRemoteSchema(service);
            
            // Wrap schema with namespace and transforms
            const wrappedSchema = this.wrapServiceSchema(schema, service);
            
            this.services.set(service.name, service);
            this.schemas.set(service.name, wrappedSchema);
            
            // Re-stitch schemas
            await this.stitchAllSchemas();
            
            this.logger.info(`Registered GraphQL service: ${service.name}`);
            return service;
        } catch (error) {
            this.logger.error(`Failed to register GraphQL service ${config.name}: ${error.message}`);
            throw error;
        }
    }

    // Introspect remote GraphQL schema
    async introspectRemoteSchema(service) {
        const executor = async ({ document, variables, context }) => {
            try {
                const query = print(document);
                
                const response = await fetch.post(service.url, 
                    { query, variables },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            ...service.headers,
                            ...(context?.headers || {})
                        },
                        timeout: service.timeout
                    }
                );
                
                const result = response.data;
                
                if (result.errors) {
                    throw new Error(JSON.stringify(result.errors));
                }
                
                return result;
            } catch (error) {
                this.logger.error(`Remote schema execution error: ${error.message}`);
                throw error;
            }
        };
        
        try {
            const schema = await introspectSchema(executor);
            return wrapSchema({
                schema,
                executor
            });
        } catch (error) {
            this.logger.error(`Failed to introspect schema from ${service.url}: ${error.message}`);
            throw error;
        }
    }

    // Wrap service schema with namespace and transforms
    wrapServiceSchema(schema, service) {
        const transforms = [...service.transforms];
        
        // Add namespace transform if specified
        if (service.namespace && service.namespace !== service.name) {
            transforms.push({
                transformSchema: (schema) => {
                    // Prefix all types with namespace
                    return this.prefixSchema(schema, service.namespace);
                }
            });
        }
        
        // Add rate limiting transform
        if (service.rateLimit) {
            transforms.push({
                transformRequest: (request) => {
                    // Check rate limit before executing
                    this.checkRateLimit(service.name, request);
                    return request;
                }
            });
        }
        
        // Add caching transform
        if (this.config.caching && service.cacheConfig) {
            transforms.push({
                transformResult: (result, request) => {
                    // Cache successful results
                    if (!result.errors) {
                        this.cacheResult(service.name, request, result, service.cacheConfig);
                    }
                    return result;
                }
            });
        }
        
        return wrapSchema({
            schema,
            transforms
        });
    }

    // Stitch all registered schemas
    async stitchAllSchemas() {
        if (this.schemas.size === 0) {
            this.stitchedSchema = null;
            return;
        }
        
        const subschemas = Array.from(this.schemas.values());
        
        // Add custom resolvers for cross-service relationships
        const resolvers = this.buildCrossServiceResolvers();
        
        // Add federation support if enabled
        if (this.config.federation) {
            // Add federation directives and types
            subschemas.push(this.getFederationSchema());
        }
        
        try {
            this.stitchedSchema = stitchSchemas({
                subschemas,
                resolvers,
                
                // Type merging configuration
                typeMergingConfig: {
                    // Define how to merge types across services
                    types: this.getTypeMergingConfig()
                }
            });
            
            this.logger.info(`Stitched ${this.schemas.size} GraphQL schemas`);
        } catch (error) {
            this.logger.error(`Failed to stitch schemas: ${error.message}`);
            throw error;
        }
    }

    // Build cross-service resolvers
    buildCrossServiceResolvers() {
        return {
            Query: {
                // Add custom query resolvers that span multiple services
            },
            Mutation: {
                // Add custom mutation resolvers
            },
            // Add type resolvers for relationships
        };
    }

    // Get type merging configuration
    getTypeMergingConfig() {
        const config = {};
        
        // Example: Merge User type across services
        config['User'] = {
            selectionSet: '{ id }',
            fieldName: 'user',
            args: (originalObject) => ({ id: originalObject.id })
        };
        
        return config;
    }

    // Get federation schema
    getFederationSchema() {
        const typeDefs = `
            scalar _Any
            scalar _FieldSet
            
            directive @external on FIELD_DEFINITION
            directive @requires(fields: _FieldSet!) on FIELD_DEFINITION
            directive @provides(fields: _FieldSet!) on FIELD_DEFINITION
            directive @key(fields: _FieldSet!) on OBJECT | INTERFACE
            directive @extends on OBJECT | INTERFACE
            
            type _Service {
                sdl: String
            }
            
            type Query {
                _service: _Service!
                _entities(representations: [_Any!]!): [_Entity]!
            }
            
            union _Entity
        `;
        
        return makeExecutableSchema({ typeDefs });
    }

    // Prefix schema types with namespace
    prefixSchema(schema, prefix) {
        // Implementation would rename all types with prefix
        // This is a simplified version
        return schema;
    }

    // Check rate limit for request
    checkRateLimit(serviceName, request) {
        if (!this.config.rateLimit) return;
        
        // Implementation would check rate limits
        // Throw error if limit exceeded
    }

    // Cache query result
    cacheResult(serviceName, request, result, cacheConfig) {
        // Implementation would cache results
        this.stats.cacheHits++;
    }

    // Create Apollo Server
    createApolloServer(app) {
        if (!this.stitchedSchema) {
            this.logger.warn('No GraphQL schema available');
            return null;
        }
        
        const server = new ApolloServer({
            schema: this.stitchedSchema,
            
            // Enable playground and introspection
            playground: this.config.playground,
            introspection: this.config.introspection,
            
            // Context function
            context: ({ req, res }) => {
                return {
                    req,
                    res,
                    user: req.user,
                    headers: req.headers,
                    services: this.services
                };
            },
            
            // Plugins
            plugins: [
                // Query complexity plugin
                {
                    requestDidStart: () => ({
                        willSendResponse: (requestContext) => {
                            // Update statistics
                            const operation = requestContext.operation;
                            if (operation) {
                                switch (operation.operation) {
                                    case 'query':
                                        this.stats.queries++;
                                        break;
                                    case 'mutation':
                                        this.stats.mutations++;
                                        break;
                                    case 'subscription':
                                        this.stats.subscriptions++;
                                        break;
                                }
                            }
                            
                            if (requestContext.errors) {
                                this.stats.errors += requestContext.errors.length;
                            }
                        }
                    })
                },
                
                // Depth limiting plugin
                this.createDepthLimitPlugin(),
                
                // Cost analysis plugin
                this.createCostAnalysisPlugin()
            ],
            
            // Error formatting
            formatError: (error) => {
                this.logger.error(`GraphQL error: ${error.message}`);
                return {
                    message: error.message,
                    extensions: {
                        code: error.extensions?.code || 'INTERNAL_ERROR',
                        timestamp: new Date().toISOString()
                    }
                };
            },
            
            // Subscriptions
            subscriptions: this.config.subscriptions ? {
                path: '/graphql/subscriptions',
                onConnect: (connectionParams, websocket, context) => {
                    this.logger.info('GraphQL subscription connected');
                    return { connectionParams };
                },
                onDisconnect: (websocket, context) => {
                    this.logger.info('GraphQL subscription disconnected');
                }
            } : false
        });
        
        server.applyMiddleware({ app, path: '/graphql' });
        
        if (this.config.subscriptions) {
            server.installSubscriptionHandlers(app);
        }
        
        this.logger.info('Apollo Server created and attached to Express');
        return server;
    }

    // Create depth limit plugin
    createDepthLimitPlugin() {
        const depthLimit = this.config.depthLimit;
        
        return {
            requestDidStart: () => ({
                validationDidStart: () => ({
                    willValidateDocument: (validationContext) => {
                        const depth = this.calculateDepth(validationContext.document);
                        if (depth > depthLimit) {
                            throw new Error(`Query depth ${depth} exceeds maximum depth ${depthLimit}`);
                        }
                    }
                })
            })
        };
    }

    // Create cost analysis plugin
    createCostAnalysisPlugin() {
        const costLimit = this.config.costLimit;
        
        return {
            requestDidStart: () => ({
                willExecuteOperation: (requestContext) => {
                    const cost = this.calculateQueryCost(requestContext.document);
                    if (cost > costLimit) {
                        throw new Error(`Query cost ${cost} exceeds maximum cost ${costLimit}`);
                    }
                }
            })
        };
    }

    // Calculate query depth
    calculateDepth(document) {
        let maxDepth = 0;
        
        const visit = (node, depth = 0) => {
            if (node.selectionSet) {
                depth++;
                maxDepth = Math.max(maxDepth, depth);
                node.selectionSet.selections.forEach(selection => {
                    visit(selection, depth);
                });
            }
        };
        
        document.definitions.forEach(definition => {
            if (definition.selectionSet) {
                definition.selectionSet.selections.forEach(selection => {
                    visit(selection);
                });
            }
        });
        
        return maxDepth;
    }

    // Calculate query cost
    calculateQueryCost(document) {
        // Simplified cost calculation
        // Real implementation would consider field complexity
        let cost = 0;
        
        const visit = (node, multiplier = 1) => {
            if (node.selectionSet) {
                cost += multiplier;
                node.selectionSet.selections.forEach(selection => {
                    // Check for list fields which have higher cost
                    const fieldMultiplier = selection.name?.value?.endsWith('s') ? 10 : 1;
                    visit(selection, multiplier * fieldMultiplier);
                });
            }
        };
        
        document.definitions.forEach(definition => {
            if (definition.selectionSet) {
                definition.selectionSet.selections.forEach(selection => {
                    visit(selection);
                });
            }
        });
        
        return cost;
    }

    // Default complexity analyzer
    defaultComplexityAnalyzer(query) {
        return {
            depth: this.calculateDepth(query),
            cost: this.calculateQueryCost(query)
        };
    }

    // Execute federated query
    async executeFederatedQuery(query, variables, context) {
        // Implementation for federated queries
        // Would handle entity resolution across services
    }

    // Handle schema updates
    async updateSchema(serviceName) {
        const service = this.services.get(serviceName);
        if (!service) {
            throw new Error(`Service ${serviceName} not found`);
        }
        
        try {
            // Re-introspect schema
            const schema = await this.introspectRemoteSchema(service);
            const wrappedSchema = this.wrapServiceSchema(schema, service);
            
            this.schemas.set(serviceName, wrappedSchema);
            
            // Re-stitch all schemas
            await this.stitchAllSchemas();
            
            this.logger.info(`Updated schema for service: ${serviceName}`);
        } catch (error) {
            this.logger.error(`Failed to update schema for ${serviceName}: ${error.message}`);
            throw error;
        }
    }

    // Remove service
    async removeService(serviceName) {
        this.services.delete(serviceName);
        this.schemas.delete(serviceName);
        
        // Re-stitch remaining schemas
        await this.stitchAllSchemas();
        
        this.logger.info(`Removed GraphQL service: ${serviceName}`);
    }

    // Get service health
    async checkServiceHealth(serviceName) {
        const service = this.services.get(serviceName);
        if (!service) return { healthy: false, error: 'Service not found' };
        
        try {
            const response = await fetch.get(service.url + service.healthCheck, {
                timeout: 5000
            });
            
            return {
                healthy: response.status === 200,
                status: response.status,
                latency: response.headers['x-response-time']
            };
        } catch (error) {
            return {
                healthy: false,
                error: error.message
            };
        }
    }

    // Get statistics
    getStats() {
        return {
            services: this.services.size,
            schemas: this.schemas.size,
            queries: this.stats.queries,
            mutations: this.stats.mutations,
            subscriptions: this.stats.subscriptions,
            errors: this.stats.errors,
            cacheHitRate: this.stats.cacheHits + this.stats.cacheMisses > 0
                ? (this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses) * 100).toFixed(2) + '%'
                : '0%'
        };
    }
}

module.exports = GraphQLProxy;