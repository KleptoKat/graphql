/*
 * Copyright (c) "Neo4j"
 * Neo4j Sweden AB [http://neo4j.com]
 *
 * This file is part of Neo4j.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Node, Relationship } from "../classes";
import WithProjector from "../classes/WithProjector";
import { AUTH_FORBIDDEN_ERROR } from "../constants";
import { Context } from "../types";
import mapToDbProperty from "../utils/map-to-db-property";
import { createConnectOrCreateAndParams } from "./connect-or-create/create-connect-or-create-and-params";
import createAuthAndParams from "./create-auth-and-params";
import createAuthParam from "./create-auth-param";
import createConnectAndParams from "./create-connect-and-params";
import createCreateAndParams from "./create-create-and-params";
import createDeleteAndParams from "./create-delete-and-params";
import createDisconnectAndParams from "./create-disconnect-and-params";
import createSetRelationshipProperties from "./create-set-relationship-properties";
import { wrapInCall } from "./utils/wrap-in-call";
import createConnectionWhereAndParams from "./where/create-connection-where-and-params";

interface Res {
    strs: string[];
    params: any;
    meta?: UpdateMeta;
}

interface UpdateMeta {
    preAuthStrs: string[];
    postAuthStrs: string[];
}

function createUpdateAndParams({
    updateInput,
    varName,
    node,
    parentVar,
    chainStr,
    insideDoWhen,
    withProjector,
    context,
    parameterPrefix,
}: {
    parentVar: string;
    updateInput: any;
    varName: string;
    chainStr?: string;
    node: Node;
    withProjector: WithProjector,
    insideDoWhen?: boolean;
    context: Context;
    parameterPrefix: string;
}): [string, any] {
    let hasAppliedTimeStamps = false;

    /**
     * **NOTE**
     * Update input is now being sent to neo4j twice. Instead of flattening each input parameter,
     * perhaps we can utilize the object being sent to neo4j?
     * `objUpdateParams` is necessary for subscriptions to sent an object containing
     * the updated properties.
     */
    const objUpdateParams = {}; 
    const objUpdateParamsKey = chainStr || `${parentVar}_update`;

    function reducer(res: Res, [key, value]: [string, any]) {
        let param;

        if (chainStr) {
            param = `${chainStr}_${key}`;
        } else {
            param = `${parentVar}_update_${key}`;
        }

        const relationField = node.relationFields.find((x) => key === x.fieldName);
        const pointField = node.pointFields.find((x) => key === x.fieldName);
        const dbFieldName = mapToDbProperty(node, key);

        if (relationField) {
            const refNodes: Node[] = [];

            const relationship = (context.neoSchema.relationships.find(
                (x) => x.properties === relationField.properties
            ) as unknown) as Relationship;

            if (relationField.union) {
                Object.keys(value).forEach((unionTypeName) => {
                    refNodes.push(context.neoSchema.nodes.find((x) => x.name === unionTypeName) as Node);
                });
            } else if (relationField.interface) {
                relationField.interface?.implementations?.forEach((implementationName) => {
                    refNodes.push(context.neoSchema.nodes.find((x) => x.name === implementationName) as Node);
                });
            } else {
                refNodes.push(context.neoSchema.nodes.find((x) => x.name === relationField.typeMeta.name) as Node);
            }

            const inStr = relationField.direction === "IN" ? "<-" : "-";
            const outStr = relationField.direction === "OUT" ? "->" : "-";

            res.strs.push(withProjector.nextWith());
            const subqueries: string[] = [];
            let subWithProjector = withProjector;
            let mutateMetaVariableDeclared = false;
            if (relationField.interface) {
                subWithProjector = withProjector.createChild(varName);
            }

            refNodes.forEach((refNode) => {
                const v = relationField.union ? value[refNode.name] : value;
                const updates = relationField.typeMeta.array ? v : [v];
                const subquery: string[] = [];

                updates.forEach((update, index) => {
                    const relationshipVariable = `${varName}_${relationField.type.toLowerCase()}${index}_relationship`;
                    const relTypeStr = `[${relationshipVariable}:${relationField.type}]`;
                    const _varName = `${varName}_${key}${relationField.union ? `_${refNode.name}` : ""}${index}`;
                    if (relationField.interface) {
                        subWithProjector.mutateMetaVariableDeclared = false;
                    }

                    if (update.update) {
                        const whereStrs: string[] = [];

                        if (update.where) {
                            try {
                                const where = createConnectionWhereAndParams({
                                    whereInput: update.where,
                                    node: refNode,
                                    nodeVariable: _varName,
                                    relationship,
                                    relationshipVariable,
                                    context,
                                    parameterPrefix: `${parameterPrefix}.${key}${
                                        relationField.union ? `.${refNode.name}` : ""
                                    }${relationField.typeMeta.array ? `[${index}]` : ``}.where`,
                                });
                                const [whereClause] = where;
                                if (whereClause) {
                                    whereStrs.push(whereClause);
                                }
                            } catch {
                                return;
                            }
                        }

                        subquery.push(subWithProjector.nextWith());

                        const labels = refNode.getLabelString(context);
                        subquery.push(
                            `OPTIONAL MATCH (${parentVar})${inStr}${relTypeStr}${outStr}(${_varName}${labels})`
                        );
                        subWithProjector.addVariable(_varName);
                        subWithProjector.addVariable(relationshipVariable);

                        if (node.auth) {
                            const whereAuth = createAuthAndParams({
                                operations: "UPDATE",
                                entity: refNode,
                                context,
                                where: { varName: _varName, node: refNode },
                            });
                            if (whereAuth[0]) {
                                whereStrs.push(whereAuth[0]);
                                res.params = { ...res.params, ...whereAuth[1] };
                            }
                        }
                        if (whereStrs.length) {
                            subquery.push(`WHERE ${whereStrs.join(" AND ")}`);
                        }

                        if (update.update.node) {
                            subquery.push(`CALL apoc.do.when(${_varName} IS NOT NULL, ${insideDoWhen ? '\\"' : '"'}`);

                            const childWithProjector = subWithProjector.createChild();

                            const auth = createAuthParam({ context });
                            let innerApocParams = { auth };
                            const nodeUpdateChainStr = `${param}${relationField.union ? `_${refNode.name}` : ""}${index}`;

                            const nestedUpdateInput = Object.entries(update.update.node)
                                .filter(([k]) => {
                                    if (k === "_on") {
                                        return false;
                                    }

                                    if (relationField.interface && update.update.node?._on?.[refNode.name]) {
                                        const onArray = Array.isArray(update.update.node._on[refNode.name])
                                            ? update.update.node._on[refNode.name]
                                            : [update.update.node._on[refNode.name]];
                                        if (onArray.some((onKey) => Object.prototype.hasOwnProperty.call(onKey, k))) {
                                            return false;
                                        }
                                    }

                                    return true;
                                })
                                .reduce((d1, [k1, v1]) => ({ ...d1, [k1]: v1 }), {});

                            const updateAndParams = createUpdateAndParams({
                                context,
                                node: refNode,
                                updateInput: nestedUpdateInput,
                                varName: _varName,
                                withProjector: childWithProjector,
                                parentVar: _varName,
                                chainStr: nodeUpdateChainStr,
                                insideDoWhen: true,
                                parameterPrefix: `${parameterPrefix}.${key}${
                                    relationField.union ? `.${refNode.name}` : ""
                                }${relationField.typeMeta.array ? `[${index}]` : ``}.update.node`,
                            });
                            res.params = { ...res.params, ...updateAndParams[1], auth };
                            innerApocParams = { ...innerApocParams, ...updateAndParams[1] };
                            const updateStrs = [updateAndParams[0]];

                            if (relationField.interface && update.update.node?._on?.[refNode.name]) {
                                const onUpdateAndParams = createUpdateAndParams({
                                    context,
                                    node: refNode,
                                    updateInput: update.update.node._on[refNode.name],
                                    varName: _varName,
                                    withProjector: childWithProjector,
                                    parentVar: _varName,
                                    chainStr: `${param}${relationField.union ? `_${refNode.name}` : ""}${index}_on_${
                                        refNode.name
                                    }`,
                                    insideDoWhen: true,
                                    parameterPrefix: `${parameterPrefix}.${key}${
                                        relationField.union ? `.${refNode.name}` : ""
                                    }${relationField.typeMeta.array ? `[${index}]` : ``}.update.node._on.${
                                        refNode.name
                                    }`,
                                });
                                res.params = { ...res.params, ...onUpdateAndParams[1], auth };
                                innerApocParams = { ...innerApocParams, ...onUpdateAndParams[1] };
                                updateStrs.push(onUpdateAndParams[0]);
                            }

                            const apocArgs = `{${subWithProjector.variables.map((withVar) => `${withVar}:${withVar}`).join(", ")}, ${
                                parameterPrefix?.split(".")[0]
                            }: $${parameterPrefix?.split(".")[0]}, ${_varName}:${_varName}REPLACE_ME}`;

                            updateStrs.push(childWithProjector.nextReturn());
                            if (insideDoWhen) {
                                updateStrs.push(`\\", \\"\\", ${apocArgs})`);
                            } else {
                                updateStrs.push(`", "", ${apocArgs})`);
                            }
                            updateStrs.push("YIELD value");
                            updateStrs.push(subWithProjector.mergeWithChild(childWithProjector, `value.${ childWithProjector.mutateMetaListVarName }`));

                            const paramsString = Object.keys(innerApocParams)
                                .reduce((r: string[], k) => [...r, `${k}:$${k}`], [])
                                .join(",");

                            const updateStr = updateStrs.join("\n").replace(/REPLACE_ME/g, `, ${paramsString}`);
                            subquery.push(updateStr);
                        }

                        if (update.update.edge) {
                            subquery.push(
                                `CALL apoc.do.when(${relationshipVariable} IS NOT NULL, ${insideDoWhen ? '\\"' : '"'}`
                            );
                            const childWithProjector = subWithProjector.createChild();
                            
                            const setRelationshipParameterPrefix = `${parameterPrefix}.${key}${
                                relationField.union ? `.${refNode.name}` : ""
                            }${relationField.typeMeta.array ? `[${index}]` : ``}.update.edge`;

                            const setProperties = createSetRelationshipProperties({
                                properties: update.update.edge,
                                varName: relationshipVariable,
                                relationship,
                                operation: "UPDATE",
                                parameterPrefix: setRelationshipParameterPrefix,
                            });

                            childWithProjector.markMutationMeta({
                                type: 'RelationshipUpdated',
                                name: node.name,
                                relationshipName: relationField.type,
                                toName: refNode.name,

                                idVar: `id(${ varName })`,
                                relationshipIDVar: `id(${ relationshipVariable })`,
                                toIDVar: `id(${ _varName })`,

                                propertiesVar: `$${ setRelationshipParameterPrefix }`,
                            });

                            const updateStrs = [setProperties];
                            updateStrs.push(childWithProjector.nextReturn());

                            const apocArgs = `{${[
                                `${relationshipVariable}:${relationshipVariable}`,
                                `${parameterPrefix?.split(".")[0]}: $${parameterPrefix?.split(".")[0]}`,
                                ...withProjector.variables.map((wpv) => `${wpv}:${wpv}`),
                            ].join(', ')}}`;

                            if (insideDoWhen) {
                                updateStrs.push(`\\", \\"\\", ${apocArgs})`);
                            } else {
                                updateStrs.push(`", "", ${apocArgs})`);
                            }
                            const valueName = `${relationshipVariable}_${key}${index}_edge`;
                            updateStrs.push(`YIELD value as ${ valueName }`);
                            updateStrs.push(subWithProjector.mergeWithChild(childWithProjector, `${ valueName }.${ childWithProjector.mutateMetaListVarName }`));
                            subquery.push(updateStrs.join("\n"));
                        }
                        subWithProjector.removeVariable(_varName);
                        subWithProjector.removeVariable(relationshipVariable);
                    }

                    if (update.disconnect) {
                        const disconnectAndParams = createDisconnectAndParams({
                            context,
                            refNodes: [refNode],
                            value: update.disconnect,
                            varName: `${_varName}_disconnect`,
                            withProjector: subWithProjector,
                            parentVar,
                            relationField,
                            labelOverride: relationField.union ? refNode.name : "",
                            parentNode: node,
                            insideDoWhen,
                            parameterPrefix: `${parameterPrefix}.${key}${
                                relationField.union ? `.${refNode.name}` : ""
                            }${relationField.typeMeta.array ? `[${index}]` : ""}.disconnect`,
                        });
                        subquery.push(disconnectAndParams[0]);
                        res.params = { ...res.params, ...disconnectAndParams[1] };
                    }

                    if (update.connect) {
                        const connectAndParams = createConnectAndParams({
                            context,
                            refNodes: [refNode],
                            value: update.connect,
                            varName: `${_varName}_connect`,
                            withProjector: subWithProjector,
                            parentVar,
                            relationField,
                            labelOverride: relationField.union ? refNode.name : "",
                            parentNode: node,
                            insideDoWhen,
                        });
                        subquery.push(connectAndParams[0]);
                        res.params = { ...res.params, ...connectAndParams[1] };
                    }

                    if (update.connectOrCreate) {
                        const [connectOrCreateQuery, connectOrCreateParams] = createConnectOrCreateAndParams({
                            input: update.connectOrCreate,
                            varName: `${_varName}_connectOrCreate`,
                            parentVar: varName,
                            relationField,
                            refNode,
                            context,
                        });
                        subquery.push(wrapInCall(connectOrCreateQuery, varName));
                        res.params = { ...res.params, ...connectOrCreateParams };
                    }

                    if (update.delete) {
                        const innerVarName = `${_varName}_delete`;

                        const deleteAndParams = createDeleteAndParams({
                            context,
                            node,
                            deleteInput: { [key]: update.delete }, // OBJECT ENTIERS key reused twice
                            varName: innerVarName,
                            chainStr: innerVarName,
                            parentVar,
                            withProjector: subWithProjector,
                            insideDoWhen,
                            parameterPrefix: `${parameterPrefix}.${key}${
                                relationField.typeMeta.array ? `[${index}]` : ``
                            }.delete`, // its use here
                            recursing: true,
                        });
                        subquery.push(deleteAndParams[0]);
                        res.params = { ...res.params, ...deleteAndParams[1] };
                    }

                    if (update.create) {

                        const creates = relationField.typeMeta.array ? update.create : [update.create];
                        creates.forEach((create, i) => {
                            const baseName = `${_varName}_create${i}`;
                            const nodeName = `${baseName}_node`;
                            const propertiesName = `${baseName}_relationship`;
                            subquery.push(subWithProjector.nextWith());
                            subWithProjector.addVariable(nodeName);

                            const createAndParams = createCreateAndParams({
                                context,
                                node: refNode,
                                input: create.node,
                                varName: nodeName,
                                withProjector: subWithProjector,
                                insideDoWhen,
                            });
                            subquery.push(createAndParams[0]);
                            res.params = { ...res.params, ...createAndParams[1] };
                            subquery.push(
                                `MERGE (${parentVar})${inStr}[${create.edge ? propertiesName : ""}:${
                                    relationField.type
                                }]${outStr}(${nodeName})`
                            );

                            if (create.edge) {
                                const setA = createSetRelationshipProperties({
                                    properties: create.edge,
                                    varName: propertiesName,
                                    relationship,
                                    operation: "CREATE",
                                    parameterPrefix: `${parameterPrefix}.${key}${
                                        relationField.union ? `.${refNode.name}` : ""
                                    }[${index}].create[${i}].edge`,
                                });
                                subquery.push(setA);
                            }
                            subWithProjector.removeVariable(nodeName);
                            subquery.push(subWithProjector.nextWith());
                        });
                    }

                    if (relationField.interface) {
                        if (subWithProjector.mutateMetaVariableDeclared) {
                            mutateMetaVariableDeclared = true;
                        }
                        subquery.push(subWithProjector.nextReturn([], {
                            excludeVariables: withProjector.variables,
                        }));
                    }
                });

                if (subquery.length) {
                    subqueries.push(subquery.join("\n"));
                }
            });

            if (relationField.interface) {
                res.strs.push("CALL {");
                res.strs.push(subqueries.join("\nUNION\n"));
                res.strs.push("}");
                if (mutateMetaVariableDeclared) {
                    res.strs.push(withProjector.mergeWithChild(subWithProjector));
                }
            } else {
                res.strs.push(subqueries.join("\n"));
            }

            return res;
        }

        if (!hasAppliedTimeStamps) {
            const timestampedFields = node.temporalFields.filter(
                (temporalField) =>
                    ["DateTime", "Time"].includes(temporalField.typeMeta.name) &&
                    temporalField.timestamps?.includes("UPDATE")
            );
            timestampedFields.forEach((field) => {
                // DateTime -> datetime(); Time -> time()
                res.strs.push(`SET ${varName}.${field.dbPropertyName} = ${field.typeMeta.name.toLowerCase()}()`);
            });

            hasAppliedTimeStamps = true;
        }

        const settableField = node.mutableFields.find((x) => x.fieldName === key);
        const authableField = node.authableFields.find((x) => x.fieldName === key);

        if (settableField) {
            if (pointField) {
                if (pointField.typeMeta.array) {
                    res.strs.push(`SET ${varName}.${dbFieldName} = [p in $${param} | point(p)]`);
                } else {
                    res.strs.push(`SET ${varName}.${dbFieldName} = point($${param})`);
                }
            } else {
                res.strs.push(`SET ${varName}.${dbFieldName} = $${param}`);
            }

            res.params[param] = value;
            objUpdateParams[key] = value;
        }

        if (authableField) {
            if (authableField.auth) {
                const preAuth = createAuthAndParams({
                    entity: authableField,
                    operations: "UPDATE",
                    context,
                    allow: { varName, parentNode: node, chainStr: param },
                    escapeQuotes: Boolean(insideDoWhen),
                });
                const postAuth = createAuthAndParams({
                    entity: authableField,
                    operations: "UPDATE",
                    skipRoles: true,
                    skipIsAuthenticated: true,
                    context,
                    bind: { parentNode: node, varName, chainStr: param },
                    escapeQuotes: Boolean(insideDoWhen),
                });

                if (!res.meta) {
                    res.meta = { preAuthStrs: [], postAuthStrs: [] };
                }

                if (preAuth[0]) {
                    res.meta.preAuthStrs.push(preAuth[0]);
                    res.params = { ...res.params, ...preAuth[1] };
                }

                if (postAuth[0]) {
                    res.meta.postAuthStrs.push(postAuth[0]);
                    res.params = { ...res.params, ...postAuth[1] };
                }
            }
        }

        return res;
    }

    // Must be generated before reducers are called
    // const preAuthWithStr = withProjector.nextWith();
    const preAuthWithStr = '';

    let params = {};

    // let { strs, params, meta = { preAuthStrs: [], postAuthStrs: [] } }
    const updateRes = Object.entries(updateInput).reduce(reducer, {
        strs: [],
        params,
    });

    let preAuthStrs: string[] = [];
    let postAuthStrs: string[] = [];
    const cypher: string[] = [];
    preAuthStrs = [ ...preAuthStrs, ...updateRes.meta?.preAuthStrs || [] ];
    postAuthStrs = [ ...postAuthStrs, ...updateRes.meta?.postAuthStrs || [] ];

    const preAuth = createAuthAndParams({
        entity: node,
        context,
        allow: { parentNode: node, varName },
        operations: "UPDATE",
        escapeQuotes: Boolean(insideDoWhen),
    });
    if (preAuth[0]) {
        preAuthStrs.push(preAuth[0]);
        params = { ...params, ...preAuth[1] };
    }

    const forbiddenString = insideDoWhen ? `\\"${AUTH_FORBIDDEN_ERROR}\\"` : `"${AUTH_FORBIDDEN_ERROR}"`;
    if (preAuthStrs.length) {
        const apocStr = `CALL apoc.util.validate(NOT(${preAuthStrs.join(" AND ")}), ${forbiddenString}, [0])`;
        cypher.push(`${preAuthWithStr}\n${apocStr}`);
    }

    cypher.push(...updateRes.strs);
    params = { ...params, ...updateRes.params };

    if (Object.keys(objUpdateParams).length) {
        withProjector.markMutationMeta({
            type: 'Updated',
            idVar: `id(${ varName })`,
            name: node.name,
            propertiesVar: `$${ objUpdateParamsKey }`,
        });
        params[objUpdateParamsKey] = objUpdateParams;
    }

    const postAuth = createAuthAndParams({
        entity: node,
        context,
        skipIsAuthenticated: true,
        skipRoles: true,
        operations: "UPDATE",
        bind: { parentNode: node, varName },
        escapeQuotes: Boolean(insideDoWhen),
    });
    if (postAuth[0]) {
        postAuthStrs.push(postAuth[0]);
        params = { ...params, ...postAuth[1] };
    }

    if (postAuthStrs.length) {
        const apocStr = `CALL apoc.util.validate(NOT(${postAuthStrs.join(" AND ")}), ${forbiddenString}, [0])`;
        // TODO: postAuthStrs with updated node ids
        cypher.push(`${ withProjector.nextWith() }`);
        cypher.push(`${apocStr}`);
    }

    const str = cypher.join('\n');

    return [str, params];
}

export default createUpdateAndParams;
