import {
  GET_LIST,
  GET_ONE,
  GET_MANY,
  GET_MANY_REFERENCE,
  CREATE,
  UPDATE,
  DELETE
} from 'react-admin';
import isObject from 'lodash/isObject';
import isDate from 'lodash/isDate';

import getFinalType from './utils/getFinalType';
import { computeFieldsToAddRemoveUpdate } from './utils/computeAddRemoveUpdate';

import {
  PRISMA_SET,
  PRISMA_CONNECT,
  PRISMA_DISCONNECT,
  PRISMA_UPDATE
} from './constants/mutations';
import {
  IntrospectionInputObjectType,
  IntrospectionObjectType,
  IntrospectionType,
  IntrospectionNamedTypeRef
} from 'graphql';
import { IntrospectionResult, Resource } from './constants/interfaces';

interface GetListParams {
  filter: { [key: string]: any };
  pagination: { page: number; perPage: number };
  sort: { field: string; order: string };
}

//TODO: Object filter weren't tested yet
const buildGetListVariables = (introspectionResults: IntrospectionResult) => (
  resource: Resource,
  aorFetchType: string,
  params: GetListParams
) => {
  const filter = Object.keys(params.filter).reduce((acc, key) => {
    if (key === 'ids') {
      return { ...acc, id_in: params.filter[key] };
    }

    if (Array.isArray(params.filter[key])) {

      const type = introspectionResults.types.find(
        t => t.name === `${resource.type.name}WhereInput`
      ) as IntrospectionInputObjectType;
      const inputField = type.inputFields.find(t => t.name === key);

      if (!!inputField) {
        return {
          ...acc,
          [key]: { id_in: params.filter[key] }
        };
      }
    }

    if (isObject(params.filter[key])) {

      const type = introspectionResults.types.find(
        t => t.name === `${resource.type.name}WhereInput`
      ) as IntrospectionInputObjectType;
      const filterSome = type.inputFields.find(t => t.name === `${key}_some`);

      if (filterSome) {
        const filter = Object.keys(params.filter[key]).reduce(
          (acc, k: string) => ({
            ...acc,
            [`${k}_in`]: params.filter[key][k] as string[]
          }),
          {} as { [key: string]: string[] }
        );
        return { ...acc, [`${key}_some`]: filter };
      }
    }

    const parts = key.split('.');

    if (parts.length > 1) {
      if (parts[1] == 'id') {
        const type = introspectionResults.types.find(
          t => t.name === `${resource.type.name}WhereInput`
        ) as IntrospectionInputObjectType;
        const filterSome = type.inputFields.find(
          t => t.name === `${parts[0]}_some`
        );

        if (filterSome) {
          return {
            ...acc,
            [`${parts[0]}_some`]: { id: params.filter[key] }
          };
        }

        return { ...acc, [parts[0]]: { id: params.filter[key] } };
      }

      const resourceField = (resource.type as IntrospectionObjectType).fields.find(
        f => f.name === parts[0]
      )!;
      if ((resourceField.type as IntrospectionNamedTypeRef).name === 'Int') {
        return { ...acc, [key]: parseInt(params.filter[key]) };
      }
      if ((resourceField.type as IntrospectionNamedTypeRef).name === 'Float') {
        return { ...acc, [key]: parseFloat(params.filter[key]) };
      }
    }

    return { ...acc, [key]: params.filter[key] };
  }, {});


  return {
    skip: (params.pagination.page - 1) * params.pagination.perPage,
    first: params.pagination.perPage,
    orderBy: `${params.sort.field}_${params.sort.order}`,
    where: filter
  };
};

const findInputFieldForType = (
  introspectionResults: IntrospectionResult,
  typeName: string,
  field: string
) => {
  const type = introspectionResults.types.find(
    t => t.name === typeName
  ) as IntrospectionInputObjectType;

  if (!type) {
    return null;
  }
  // if field fish with Ids, its an array of relation

  const inputFieldType = type.inputFields.find(t => t.name === field);

  return !!inputFieldType ? getFinalType(inputFieldType.type) : null;
};

const inputFieldExistsForType = (
  introspectionResults: IntrospectionResult,
  typeName: string,
  field: string
): boolean => {
  return !!findInputFieldForType(introspectionResults, typeName, field);
};

const buildReferenceField = ({
  inputArg,
  introspectionResults,
  typeName,
  field,
  mutationType
}: {
  inputArg: { [key: string]: any };
  introspectionResults: IntrospectionResult;
  typeName: string;
  field: string;
  mutationType: string;
}) => {
  const inputType = findInputFieldForType(
    introspectionResults,
    typeName,
    field
  );
  const mutationInputType = findInputFieldForType(
    introspectionResults,
    inputType!.name,
    mutationType
  );

  return Object.keys(inputArg).reduce((acc, key) => {
    return ((Object.keys(acc).length === 0) && inputFieldExistsForType(
      introspectionResults,
      mutationInputType!.name,
      key
    ))
      ? { ...acc, [key]: inputArg[key] }
      : acc;
  }, {});
};

interface UpdateParams {
  id: string;
  data: { [key: string]: any };
  previousData: { [key: string]: any };
}

const buildUpdateVariables = (introspectionResults: IntrospectionResult) => (
  resource: Resource,
  aorFetchType: String,
  params: UpdateParams
) => Object.keys(params.data).reduce(
  (acc, key) => {
    let data = params.data[key]
    let previousData = params.previousData[key]
    if (Array.isArray(data)) {

      // if key finish with Ids, its an array of relation
      if (/Ids$/.test(key)) {
        previousData = params.previousData[key].map((id: string) => ({ id }))
        //we remove Ids form field
        key = key.replace(/Ids$/, '')
        //and put id in the array
        data = data.map((id: string) => ({ id }))

      }

      const inputType = findInputFieldForType(
        introspectionResults,
        `${resource.type.name}UpdateInput`,
        key
      );

      if (!inputType) {
        return acc;
      }

      // if its an array, it can be an array of relation or an array of Scalar
      // we check the corresponding input in introspectionresult to know if it use "set" or something else

      const hasConnectMethod = findInputFieldForType(
        introspectionResults,
        inputType.name,
        'connect'
      );
      if (!hasConnectMethod) {
        return {
          ...acc,
          data: {
            ...acc.data,
            [key]: {
              [PRISMA_SET]: data
            }
          }
        };
      }

      //if key connect already exist we dont do anything
      const {
        fieldsToAdd,
        fieldsToRemove
      } = computeFieldsToAddRemoveUpdate(
        previousData,
        data
      );
      return {
        ...acc,
        data: {
          ...acc.data,
          [key]: {
            [PRISMA_CONNECT]: fieldsToAdd,
            [PRISMA_DISCONNECT]: fieldsToRemove
          }
        }
      };
    }

    if (isObject(data) && !isDate(data)) {

      const fieldsToUpdate = buildReferenceField({
        inputArg: data,
        introspectionResults,
        typeName: `${resource.type.name}UpdateInput`,
        field: key,
        mutationType: PRISMA_CONNECT
      });

      // If no fields in the object are valid, continue
      if (Object.keys(fieldsToUpdate).length === 0) {
        return acc;
      }

      // Else, connect the nodes
      return {
        ...acc,
        data: {
          ...acc.data,
          [key]: { [PRISMA_CONNECT]: { ...fieldsToUpdate } }
        }
      };
    }

    // Put id field in a where object
    if (key === 'id' && data) {
      return {
        ...acc,
        where: {
          id: data
        }
      };
    }


    const type = introspectionResults.types.find(
      t => t.name === resource.type.name
    ) as IntrospectionObjectType;

    const isInField = type.fields.find(t => t.name === key);


    if (!!isInField) {
      // Rest should be put in data object

      return {
        ...acc,
        data: {
          ...acc.data,
          [key]: data
        }
      };
    }

    return acc;
  },
  {} as { [key: string]: any }
);

interface CreateParams {
  data: { [key: string]: any };
}

const buildCreateVariables = (introspectionResults: IntrospectionResult) => (
  resource: Resource,
  aorFetchType: string,
  params: CreateParams
) =>
  Object.keys(params.data).reduce(
    (acc, key) => {
      let data = params.data[key]
      if (Array.isArray(data)) {

        // if key finish with Ids, its an array of relation
        if (/Ids$/.test(key)) {
          //we remove Ids form field
          key = key.replace(/Ids$/, '')
          //and put id in the array
          data = data.map((id: string) => ({ id }))
        }

        let entryIsObject = data.some((entry: any) => isObject(entry) && !isDate(entry))

        if (entryIsObject) {
          data = data.map((entry: any) => Object.keys(entry)
            .reduce((obj: any, key: any) => {
              if (key === 'id') {
                obj[key] = entry[key]
              }
              return obj;
            }, {}))
        }

        const inputType = findInputFieldForType(
          introspectionResults,
          `${resource.type.name}CreateInput`,
          key
        );
        if (!inputType) {
          return acc;
        }


        // if its an array, it can be an array of relation or an array of Scalar
        // we check the corresponding input in introspectionresult to know if it use "set" or something else

        const hasSetMethod = findInputFieldForType(
          introspectionResults,
          inputType.name,
          'set'
        );

        if (hasSetMethod) {
          return {
            ...acc,
            data: {
              ...acc.data,
              [key]: {
                [PRISMA_SET]: data
              }
            }
          };
        }

        return {
          ...acc,
          data: {
            ...acc.data,
            [key]: {
              [PRISMA_CONNECT]: data
            }
          }
        };
      }

      if (isObject(data) && !isDate(data)) {
        const fieldsToConnect = buildReferenceField({
          inputArg: data,
          introspectionResults,
          typeName: `${resource.type.name}CreateInput`,
          field: key,
          mutationType: PRISMA_CONNECT
        });
        // If no fields in the object are valid, continue
        if (Object.keys(fieldsToConnect).length === 0) {
          return acc;
        }

        // Else, connect the nodes
        return {
          ...acc,
          data: {
            ...acc.data,
            [key]: { [PRISMA_CONNECT]: { ...fieldsToConnect } }
          }
        };
      }


      // Put id field in a where object
      if (key === 'id' && params.data[key]) {
        return {
          ...acc,
          where: {
            id: params.data[key]
          }
        };
      }

      const type = introspectionResults.types.find(
        t => t.name === resource.type.name
      ) as IntrospectionObjectType;
      const isInField = type.fields.find(t => t.name === key);

      if (isInField) {
        // Rest should be put in data object
        return {
          ...acc,
          data: {
            ...acc.data,
            [key]: data
          }
        };
      }

      return acc;
    },
    {} as { [key: string]: any }
  );

export default (introspectionResults: IntrospectionResult) => (
  resource: Resource,
  aorFetchType: string,
  params: any
) => {
  switch (aorFetchType) {
    case GET_LIST: {
      return buildGetListVariables(introspectionResults)(
        resource,
        aorFetchType,
        params
      );
    }
    case GET_MANY:
      return {
        where: { id_in: params.ids }
      };
    case GET_MANY_REFERENCE: {
      const parts = params.target.split('.');

      return {
        where: { [parts[0]]: { id: params.id } }
      };
    }
    case GET_ONE:
      return {
        where: { id: params.id }
      };
    case UPDATE: {
      const variables = buildUpdateVariables(introspectionResults)(
        resource,
        aorFetchType,
        params
      );
      return variables
    }

    case CREATE: {
      return buildCreateVariables(introspectionResults)(
        resource,
        aorFetchType,
        params
      );
    }

    case DELETE:
      return {
        where: { id: params.id }
      };
  }
};
