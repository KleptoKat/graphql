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

import { FieldNode, GraphQLResolveInfo } from "graphql";
import { Node } from "../../classes";
import { translateCreate } from "../../translate";
import { Context } from "../../types";
import { execute, publishMutateMeta } from "../../utils";

export default function createResolver({ node }: { node: Node }) {
    async function resolve(_root: any, _args: any, _context: unknown, info: GraphQLResolveInfo) {
        const context = _context as Context;
        const [cypher, params] = translateCreate({ context, node });

        const executeResult = await execute({
            cypher,
            params,
            defaultAccessMode: "WRITE",
            context,
        });

        const responseField = info.fieldNodes[0].selectionSet?.selections.find(
            (selection) => selection.kind === "Field" && selection.name.value === node.getPlural({ camelCase: true })
        ) as FieldNode; // Field exist by construction and must be selected as it is the only field.

        const responseKey = responseField.alias ? responseField.alias.value : responseField.name.value;
        const record = executeResult.records[0] || {};
        if (record.mutateMeta) {
            publishMutateMeta({
                context,
                executeResult,
            });
            delete record.mutateMeta;
        }

        const result = Object.values(record);

        return {
            info: {
                bookmark: executeResult.bookmark,
                ...executeResult.statistics,
            },
            [responseKey]: result,
        };
    }

    return {
        type: `Create${node.getPlural({ camelCase: false })}MutationResponse!`,
        resolve,
        args: { input: `[${node.name}CreateInput!]!` },
    };
}
