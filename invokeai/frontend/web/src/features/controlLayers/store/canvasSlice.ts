import type { PayloadAction, UnknownAction } from '@reduxjs/toolkit';
import { createSlice, isAnyOf } from '@reduxjs/toolkit';
import type { PersistConfig } from 'app/store/store';
import { moveOneToEnd, moveOneToStart, moveToEnd, moveToStart } from 'common/util/arrayUtils';
import { deepClone } from 'common/util/deepClone';
import { roundDownToMultiple, roundToMultiple } from 'common/util/roundDownToMultiple';
import { merge } from 'es-toolkit/compat';
import { getPrefixedId } from 'features/controlLayers/konva/util';
import { canvasReset } from 'features/controlLayers/store/actions';
import { modelChanged } from 'features/controlLayers/store/paramsSlice';
import {
  selectAllEntities,
  selectAllEntitiesOfType,
  selectEntity,
  selectRegionalGuidanceReferenceImage,
} from 'features/controlLayers/store/selectors';
import type {
  CanvasEntityStateFromType,
  CanvasEntityType,
  CanvasInpaintMaskState,
  CanvasMetadata,
  ControlLoRAConfig,
  EntityMovedByPayload,
  FillStyle,
  FLUXReduxImageInfluence,
  RegionalGuidanceRefImageState,
  RgbColor,
} from 'features/controlLayers/store/types';
import {
  calculateNewSize,
  getScaledBoundingBoxDimensions,
} from 'features/controlLayers/util/getScaledBoundingBoxDimensions';
import { simplifyFlatNumbersArray } from 'features/controlLayers/util/simplify';
import { isMainModelBase, zModelIdentifierField } from 'features/nodes/types/common';
import { API_BASE_MODELS } from 'features/parameters/types/constants';
import { getGridSize, getIsSizeOptimal, getOptimalDimension } from 'features/parameters/util/optimalDimension';
import type { IRect } from 'konva/lib/types';
import type { UndoableOptions } from 'redux-undo';
import {
  type ControlLoRAModelConfig,
  type ControlNetModelConfig,
  type FLUXReduxModelConfig,
  type ImageDTO,
  type IPAdapterModelConfig,
  isFluxReduxModelConfig,
  isIPAdapterModelConfig,
  type T2IAdapterModelConfig,
} from 'services/api/types';

import type {
  AspectRatioID,
  BoundingBoxScaleMethod,
  CanvasControlLayerState,
  CanvasEntityIdentifier,
  CanvasRasterLayerState,
  CanvasRegionalGuidanceState,
  CanvasState,
  CLIPVisionModelV2,
  ControlModeV2,
  ControlNetConfig,
  EntityBrushLineAddedPayload,
  EntityEraserLineAddedPayload,
  EntityIdentifierPayload,
  EntityMovedToPayload,
  EntityRasterizedPayload,
  EntityRectAddedPayload,
  IPMethodV2,
  T2IAdapterConfig,
} from './types';
import {
  ASPECT_RATIO_MAP,
  CHATGPT_ASPECT_RATIOS,
  DEFAULT_ASPECT_RATIO_CONFIG,
  FLUX_KONTEXT_ASPECT_RATIOS,
  getEntityIdentifier,
  getInitialCanvasState,
  IMAGEN_ASPECT_RATIOS,
  isChatGPT4oAspectRatioID,
  isFluxKontextAspectRatioID,
  isFLUXReduxConfig,
  isImagenAspectRatioID,
  isIPAdapterConfig,
} from './types';
import {
  converters,
  getControlLayerState,
  getInpaintMaskState,
  getRasterLayerState,
  getRegionalGuidanceState,
  imageDTOToImageWithDims,
  initialControlLoRA,
  initialControlNet,
  initialFLUXRedux,
  initialIPAdapter,
  initialT2IAdapter,
} from './util';

export const canvasSlice = createSlice({
  name: 'canvas',
  initialState: getInitialCanvasState(),
  reducers: {
    // undoable canvas state
    //#region Raster layers
    rasterLayerAdded: {
      reducer: (
        state,
        action: PayloadAction<{
          id: string;
          overrides?: Partial<CanvasRasterLayerState>;
          isSelected?: boolean;
          isBookmarked?: boolean;
          mergedEntitiesToDelete?: string[];
        }>
      ) => {
        const { id, overrides, isSelected, isBookmarked, mergedEntitiesToDelete = [] } = action.payload;
        const entityState = getRasterLayerState(id, overrides);

        state.rasterLayers.entities.push(entityState);

        if (mergedEntitiesToDelete.length > 0) {
          state.rasterLayers.entities = state.rasterLayers.entities.filter(
            (entity) => !mergedEntitiesToDelete.includes(entity.id)
          );
        }

        const entityIdentifier = getEntityIdentifier(entityState);

        if (isSelected || mergedEntitiesToDelete.length > 0) {
          state.selectedEntityIdentifier = entityIdentifier;
        }

        if (isBookmarked) {
          state.bookmarkedEntityIdentifier = entityIdentifier;
        }
      },
      prepare: (payload: {
        overrides?: Partial<CanvasRasterLayerState>;
        isSelected?: boolean;
        isBookmarked?: boolean;
        mergedEntitiesToDelete?: string[];
      }) => ({
        payload: { ...payload, id: getPrefixedId('raster_layer') },
      }),
    },
    rasterLayerRecalled: (state, action: PayloadAction<{ data: CanvasRasterLayerState }>) => {
      const { data } = action.payload;
      state.rasterLayers.entities.push(data);
      state.selectedEntityIdentifier = getEntityIdentifier(data);
    },
    rasterLayerConvertedToControlLayer: {
      reducer: (
        state,
        action: PayloadAction<
          EntityIdentifierPayload<
            { newId: string; overrides?: Partial<CanvasControlLayerState>; replace?: boolean },
            'raster_layer'
          >
        >
      ) => {
        const { entityIdentifier, newId, overrides, replace } = action.payload;
        const layer = selectEntity(state, entityIdentifier);
        if (!layer) {
          return;
        }

        // Convert the raster layer to control layer
        const controlLayerState = converters.rasterLayer.toControlLayer(newId, layer, overrides);

        if (replace) {
          // Remove the raster layer
          state.rasterLayers.entities = state.rasterLayers.entities.filter((layer) => layer.id !== entityIdentifier.id);
        }

        // Add the converted control layer
        state.controlLayers.entities.push(controlLayerState);

        state.selectedEntityIdentifier = { type: controlLayerState.type, id: controlLayerState.id };
      },
      prepare: (
        payload: EntityIdentifierPayload<
          { overrides?: Partial<CanvasControlLayerState>; replace?: boolean } | undefined,
          'raster_layer'
        >
      ) => ({
        payload: { ...payload, newId: getPrefixedId('control_layer') },
      }),
    },
    rasterLayerConvertedToInpaintMask: {
      reducer: (
        state,
        action: PayloadAction<
          EntityIdentifierPayload<
            { newId: string; overrides?: Partial<CanvasInpaintMaskState>; replace?: boolean },
            'raster_layer'
          >
        >
      ) => {
        const { entityIdentifier, newId, overrides, replace } = action.payload;
        const layer = selectEntity(state, entityIdentifier);
        if (!layer) {
          return;
        }

        // Convert the raster layer to inpaint mask
        const inpaintMaskState = converters.rasterLayer.toInpaintMask(newId, layer, overrides);

        if (replace) {
          // Remove the raster layer
          state.rasterLayers.entities = state.rasterLayers.entities.filter((layer) => layer.id !== entityIdentifier.id);
        }

        // Add the converted inpaint mask
        state.inpaintMasks.entities.push(inpaintMaskState);

        state.selectedEntityIdentifier = { type: inpaintMaskState.type, id: inpaintMaskState.id };
      },
      prepare: (
        payload: EntityIdentifierPayload<
          { overrides?: Partial<CanvasInpaintMaskState>; replace?: boolean } | undefined,
          'raster_layer'
        >
      ) => ({
        payload: { ...payload, newId: getPrefixedId('inpaint_mask') },
      }),
    },
    rasterLayerConvertedToRegionalGuidance: {
      reducer: (
        state,
        action: PayloadAction<
          EntityIdentifierPayload<
            { newId: string; overrides?: Partial<CanvasRegionalGuidanceState>; replace?: boolean },
            'raster_layer'
          >
        >
      ) => {
        const { entityIdentifier, newId, overrides, replace } = action.payload;
        const layer = selectEntity(state, entityIdentifier);
        if (!layer) {
          return;
        }

        // Convert the raster layer to inpaint mask
        const regionalGuidanceState = converters.rasterLayer.toRegionalGuidance(newId, layer, overrides);

        if (replace) {
          // Remove the raster layer
          state.rasterLayers.entities = state.rasterLayers.entities.filter((layer) => layer.id !== entityIdentifier.id);
        }

        // Add the converted inpaint mask
        state.regionalGuidance.entities.push(regionalGuidanceState);

        state.selectedEntityIdentifier = { type: regionalGuidanceState.type, id: regionalGuidanceState.id };
      },
      prepare: (
        payload: EntityIdentifierPayload<
          { overrides?: Partial<CanvasRegionalGuidanceState>; replace?: boolean } | undefined,
          'raster_layer'
        >
      ) => ({
        payload: { ...payload, newId: getPrefixedId('regional_guidance') },
      }),
    },
    //#region Control layers
    controlLayerAdded: {
      reducer: (
        state,
        action: PayloadAction<{
          id: string;
          overrides?: Partial<CanvasControlLayerState>;
          isSelected?: boolean;
          isBookmarked?: boolean;
          mergedEntitiesToDelete?: string[];
        }>
      ) => {
        const { id, overrides, isSelected, isBookmarked, mergedEntitiesToDelete = [] } = action.payload;

        const entityState = getControlLayerState(id, overrides);

        state.controlLayers.entities.push(entityState);

        if (mergedEntitiesToDelete.length > 0) {
          state.controlLayers.entities = state.controlLayers.entities.filter(
            (entity) => !mergedEntitiesToDelete.includes(entity.id)
          );
        }
        const entityIdentifier = getEntityIdentifier(entityState);

        if (isSelected || mergedEntitiesToDelete.length > 0) {
          state.selectedEntityIdentifier = entityIdentifier;
        }

        if (isBookmarked) {
          state.bookmarkedEntityIdentifier = entityIdentifier;
        }
      },
      prepare: (payload: {
        overrides?: Partial<CanvasControlLayerState>;
        isSelected?: boolean;
        isBookmarked?: boolean;
        mergedEntitiesToDelete?: string[];
      }) => ({
        payload: { ...payload, id: getPrefixedId('control_layer') },
      }),
    },
    controlLayerRecalled: (state, action: PayloadAction<{ data: CanvasControlLayerState }>) => {
      const { data } = action.payload;
      state.controlLayers.entities.push(data);
      state.selectedEntityIdentifier = { type: 'control_layer', id: data.id };
    },
    controlLayerConvertedToRasterLayer: {
      reducer: (
        state,
        action: PayloadAction<
          EntityIdentifierPayload<
            { newId: string; overrides?: Partial<CanvasRasterLayerState>; replace?: boolean },
            'control_layer'
          >
        >
      ) => {
        const { entityIdentifier, newId, overrides, replace } = action.payload;
        const layer = selectEntity(state, entityIdentifier);
        if (!layer) {
          return;
        }

        // Convert the raster layer to control layer
        const rasterLayerState = converters.controlLayer.toRasterLayer(newId, layer, overrides);

        if (replace) {
          // Remove the control layer
          state.controlLayers.entities = state.controlLayers.entities.filter(
            (layer) => layer.id !== entityIdentifier.id
          );
        }

        // Add the new raster layer
        state.rasterLayers.entities.push(rasterLayerState);

        state.selectedEntityIdentifier = { type: rasterLayerState.type, id: rasterLayerState.id };
      },
      prepare: (
        payload: EntityIdentifierPayload<
          { overrides?: Partial<CanvasRasterLayerState>; replace?: boolean } | undefined,
          'control_layer'
        >
      ) => ({
        payload: { ...payload, newId: getPrefixedId('raster_layer') },
      }),
    },
    controlLayerConvertedToInpaintMask: {
      reducer: (
        state,
        action: PayloadAction<
          EntityIdentifierPayload<
            { newId: string; overrides?: Partial<CanvasInpaintMaskState>; replace?: boolean },
            'control_layer'
          >
        >
      ) => {
        const { entityIdentifier, newId, overrides, replace } = action.payload;
        const layer = selectEntity(state, entityIdentifier);
        if (!layer) {
          return;
        }

        // Convert the control layer to inpaint mask
        const inpaintMaskState = converters.controlLayer.toInpaintMask(newId, layer, overrides);

        if (replace) {
          // Remove the control layer
          state.controlLayers.entities = state.controlLayers.entities.filter(
            (layer) => layer.id !== entityIdentifier.id
          );
        }

        // Add the new inpaint mask
        state.inpaintMasks.entities.push(inpaintMaskState);

        state.selectedEntityIdentifier = { type: inpaintMaskState.type, id: inpaintMaskState.id };
      },
      prepare: (
        payload: EntityIdentifierPayload<
          { overrides?: Partial<CanvasInpaintMaskState>; replace?: boolean } | undefined,
          'control_layer'
        >
      ) => ({
        payload: { ...payload, newId: getPrefixedId('inpaint_mask') },
      }),
    },
    controlLayerConvertedToRegionalGuidance: {
      reducer: (
        state,
        action: PayloadAction<
          EntityIdentifierPayload<
            { newId: string; overrides?: Partial<CanvasRegionalGuidanceState>; replace?: boolean },
            'control_layer'
          >
        >
      ) => {
        const { entityIdentifier, newId, overrides, replace } = action.payload;
        const layer = selectEntity(state, entityIdentifier);
        if (!layer) {
          return;
        }

        // Convert the control layer to regional guidance
        const regionalGuidanceState = converters.controlLayer.toRegionalGuidance(newId, layer, overrides);

        if (replace) {
          // Remove the control layer
          state.controlLayers.entities = state.controlLayers.entities.filter(
            (layer) => layer.id !== entityIdentifier.id
          );
        }

        // Add the new regional guidance
        state.regionalGuidance.entities.push(regionalGuidanceState);

        state.selectedEntityIdentifier = { type: regionalGuidanceState.type, id: regionalGuidanceState.id };
      },
      prepare: (
        payload: EntityIdentifierPayload<
          { overrides?: Partial<CanvasRegionalGuidanceState>; replace?: boolean } | undefined,
          'control_layer'
        >
      ) => ({
        payload: { ...payload, newId: getPrefixedId('regional_guidance') },
      }),
    },
    controlLayerModelChanged: (
      state,
      action: PayloadAction<
        EntityIdentifierPayload<
          {
            modelConfig: ControlNetModelConfig | T2IAdapterModelConfig | ControlLoRAModelConfig | null;
          },
          'control_layer'
        >
      >
    ) => {
      const { entityIdentifier, modelConfig } = action.payload;
      const layer = selectEntity(state, entityIdentifier);
      if (!layer || !layer.controlAdapter) {
        return;
      }
      if (!modelConfig) {
        layer.controlAdapter.model = null;
        return;
      }
      layer.controlAdapter.model = zModelIdentifierField.parse(modelConfig);

      // When converting between control layer types, we may need to add or remove properties. For example, ControlNet
      // has a control mode, while T2I Adapter does not - otherwise they are the same.

      switch (layer.controlAdapter.model.type) {
        // Converting to T2I adapter from...
        case 't2i_adapter': {
          if (layer.controlAdapter.type === 'controlnet') {
            // T2I Adapters have all the ControlNet properties, minus control mode - strip it
            const { controlMode: _, ...rest } = layer.controlAdapter;
            const t2iAdapterConfig: T2IAdapterConfig = { ...initialT2IAdapter, ...rest, type: 't2i_adapter' };
            layer.controlAdapter = t2iAdapterConfig;
          } else if (layer.controlAdapter.type === 'control_lora') {
            // Control LoRAs have only model and weight
            const t2iAdapterConfig: T2IAdapterConfig = {
              ...initialT2IAdapter,
              ...layer.controlAdapter,
              type: 't2i_adapter',
            };
            layer.controlAdapter = t2iAdapterConfig;
          }
          break;
        }

        // Converting to ControlNet from...
        case 'controlnet': {
          if (layer.controlAdapter.type === 't2i_adapter') {
            // ControlNets have all the T2I Adapter properties, plus control mode
            const controlNetConfig: ControlNetConfig = {
              ...initialControlNet,
              ...layer.controlAdapter,
              type: 'controlnet',
            };
            layer.controlAdapter = controlNetConfig;
          } else if (layer.controlAdapter.type === 'control_lora') {
            // ControlNets have all the Control LoRA properties, plus control mode and begin/end step pct
            const controlNetConfig: ControlNetConfig = {
              ...initialControlNet,
              ...layer.controlAdapter,
              type: 'controlnet',
            };
            layer.controlAdapter = controlNetConfig;
          }
          break;
        }

        // Converting to ControlLoRA from...
        case 'control_lora': {
          if (layer.controlAdapter.type === 'controlnet') {
            // We only need the model and weight for Control LoRA
            const { model, weight } = layer.controlAdapter;
            const controlNetConfig: ControlLoRAConfig = { ...initialControlLoRA, model, weight };
            layer.controlAdapter = controlNetConfig;
          } else if (layer.controlAdapter.type === 't2i_adapter') {
            // We only need the model and weight for Control LoRA
            const { model, weight } = layer.controlAdapter;
            const t2iAdapterConfig: ControlLoRAConfig = { ...initialControlLoRA, model, weight };
            layer.controlAdapter = t2iAdapterConfig;
          }
          break;
        }

        default:
          break;
      }
    },
    controlLayerControlModeChanged: (
      state,
      action: PayloadAction<EntityIdentifierPayload<{ controlMode: ControlModeV2 }, 'control_layer'>>
    ) => {
      const { entityIdentifier, controlMode } = action.payload;
      const layer = selectEntity(state, entityIdentifier);
      if (!layer || !layer.controlAdapter || layer.controlAdapter.type !== 'controlnet') {
        return;
      }
      layer.controlAdapter.controlMode = controlMode;
    },
    controlLayerWeightChanged: (
      state,
      action: PayloadAction<EntityIdentifierPayload<{ weight: number }, 'control_layer'>>
    ) => {
      const { entityIdentifier, weight } = action.payload;
      const layer = selectEntity(state, entityIdentifier);
      if (!layer || !layer.controlAdapter) {
        return;
      }
      layer.controlAdapter.weight = weight;
    },
    controlLayerBeginEndStepPctChanged: (
      state,
      action: PayloadAction<EntityIdentifierPayload<{ beginEndStepPct: [number, number] }, 'control_layer'>>
    ) => {
      const { entityIdentifier, beginEndStepPct } = action.payload;
      const layer = selectEntity(state, entityIdentifier);
      if (!layer || !layer.controlAdapter || layer.controlAdapter.type === 'control_lora') {
        return;
      }
      layer.controlAdapter.beginEndStepPct = beginEndStepPct;
    },
    controlLayerWithTransparencyEffectToggled: (
      state,
      action: PayloadAction<EntityIdentifierPayload<void, 'control_layer'>>
    ) => {
      const { entityIdentifier } = action.payload;
      const layer = selectEntity(state, entityIdentifier);
      if (!layer) {
        return;
      }
      layer.withTransparencyEffect = !layer.withTransparencyEffect;
    },
    //#region Regional Guidance
    rgAdded: {
      reducer: (
        state,
        action: PayloadAction<{
          id: string;
          overrides?: Partial<CanvasRegionalGuidanceState>;
          isSelected?: boolean;
          isBookmarked?: boolean;
          mergedEntitiesToDelete?: string[];
        }>
      ) => {
        const { id, overrides, isSelected, isBookmarked, mergedEntitiesToDelete = [] } = action.payload;

        const entityState = getRegionalGuidanceState(id, overrides);

        state.regionalGuidance.entities.push(entityState);

        if (mergedEntitiesToDelete.length > 0) {
          state.regionalGuidance.entities = state.regionalGuidance.entities.filter(
            (entity) => !mergedEntitiesToDelete.includes(entity.id)
          );
        }
        const entityIdentifier = getEntityIdentifier(entityState);

        if (isSelected || mergedEntitiesToDelete.length > 0) {
          state.selectedEntityIdentifier = entityIdentifier;
        }

        if (isBookmarked) {
          state.bookmarkedEntityIdentifier = entityIdentifier;
        }
      },
      prepare: (payload?: {
        overrides?: Partial<CanvasRegionalGuidanceState>;
        isSelected?: boolean;
        isBookmarked?: boolean;
        mergedEntitiesToDelete?: string[];
      }) => ({
        payload: { ...payload, id: getPrefixedId('regional_guidance') },
      }),
    },
    rgRecalled: (state, action: PayloadAction<{ data: CanvasRegionalGuidanceState }>) => {
      const { data } = action.payload;
      state.regionalGuidance.entities.push(data);
      state.selectedEntityIdentifier = { type: 'regional_guidance', id: data.id };
    },
    rgConvertedToInpaintMask: {
      reducer: (
        state,
        action: PayloadAction<
          EntityIdentifierPayload<
            { newId: string; overrides?: Partial<CanvasInpaintMaskState>; replace?: boolean },
            'regional_guidance'
          >
        >
      ) => {
        const { entityIdentifier, newId, overrides, replace } = action.payload;
        const layer = selectEntity(state, entityIdentifier);
        if (!layer) {
          return;
        }

        // Convert the regional guidance to inpaint mask
        const inpaintMaskState = converters.regionalGuidance.toInpaintMask(newId, layer, overrides);

        if (replace) {
          // Remove the regional guidance
          state.regionalGuidance.entities = state.regionalGuidance.entities.filter(
            (layer) => layer.id !== entityIdentifier.id
          );
        }

        // Add the new inpaint mask
        state.inpaintMasks.entities.push(inpaintMaskState);

        state.selectedEntityIdentifier = { type: inpaintMaskState.type, id: inpaintMaskState.id };
      },
      prepare: (
        payload: EntityIdentifierPayload<
          { overrides?: Partial<CanvasInpaintMaskState>; replace?: boolean } | undefined,
          'regional_guidance'
        >
      ) => ({
        payload: { ...payload, newId: getPrefixedId('inpaint_mask') },
      }),
    },
    rgPositivePromptChanged: (
      state,
      action: PayloadAction<EntityIdentifierPayload<{ prompt: string | null }, 'regional_guidance'>>
    ) => {
      const { entityIdentifier, prompt } = action.payload;
      const entity = selectEntity(state, entityIdentifier);
      if (!entity) {
        return;
      }
      entity.positivePrompt = prompt;
    },
    rgNegativePromptChanged: (
      state,
      action: PayloadAction<EntityIdentifierPayload<{ prompt: string | null }, 'regional_guidance'>>
    ) => {
      const { entityIdentifier, prompt } = action.payload;
      const entity = selectEntity(state, entityIdentifier);
      if (!entity) {
        return;
      }
      entity.negativePrompt = prompt;
    },
    rgAutoNegativeToggled: (state, action: PayloadAction<EntityIdentifierPayload<void, 'regional_guidance'>>) => {
      const { entityIdentifier } = action.payload;
      const rg = selectEntity(state, entityIdentifier);
      if (!rg) {
        return;
      }
      rg.autoNegative = !rg.autoNegative;
    },
    rgRefImageAdded: {
      reducer: (
        state,
        action: PayloadAction<
          EntityIdentifierPayload<
            { referenceImageId: string; overrides?: Partial<RegionalGuidanceRefImageState> },
            'regional_guidance'
          >
        >
      ) => {
        const { entityIdentifier, overrides, referenceImageId } = action.payload;
        const entity = selectEntity(state, entityIdentifier);
        if (!entity) {
          return;
        }
        const config = { id: referenceImageId, config: deepClone(initialIPAdapter) };
        merge(config, overrides);
        entity.referenceImages.push(config);
      },
      prepare: (
        payload: EntityIdentifierPayload<{ overrides?: Partial<RegionalGuidanceRefImageState> }, 'regional_guidance'>
      ) => ({
        payload: { ...payload, referenceImageId: getPrefixedId('regional_guidance_ip_adapter') },
      }),
    },
    rgRefImageDeleted: (
      state,
      action: PayloadAction<EntityIdentifierPayload<{ referenceImageId: string }, 'regional_guidance'>>
    ) => {
      const { entityIdentifier, referenceImageId } = action.payload;
      const entity = selectEntity(state, entityIdentifier);
      if (!entity) {
        return;
      }
      entity.referenceImages = entity.referenceImages.filter((config) => config.id !== referenceImageId);
    },
    rgRefImageImageChanged: (
      state,
      action: PayloadAction<
        EntityIdentifierPayload<{ referenceImageId: string; imageDTO: ImageDTO | null }, 'regional_guidance'>
      >
    ) => {
      const { entityIdentifier, referenceImageId, imageDTO } = action.payload;
      const referenceImage = selectRegionalGuidanceReferenceImage(state, entityIdentifier, referenceImageId);
      if (!referenceImage) {
        return;
      }
      referenceImage.config.image = imageDTO ? imageDTOToImageWithDims(imageDTO) : null;
    },
    rgRefImageIPAdapterWeightChanged: (
      state,
      action: PayloadAction<EntityIdentifierPayload<{ referenceImageId: string; weight: number }, 'regional_guidance'>>
    ) => {
      const { entityIdentifier, referenceImageId, weight } = action.payload;
      const referenceImage = selectRegionalGuidanceReferenceImage(state, entityIdentifier, referenceImageId);
      if (!referenceImage) {
        return;
      }
      if (!isIPAdapterConfig(referenceImage.config)) {
        return;
      }

      referenceImage.config.weight = weight;
    },
    rgRefImageIPAdapterBeginEndStepPctChanged: (
      state,
      action: PayloadAction<
        EntityIdentifierPayload<{ referenceImageId: string; beginEndStepPct: [number, number] }, 'regional_guidance'>
      >
    ) => {
      const { entityIdentifier, referenceImageId, beginEndStepPct } = action.payload;
      const referenceImage = selectRegionalGuidanceReferenceImage(state, entityIdentifier, referenceImageId);
      if (!referenceImage) {
        return;
      }
      if (!isIPAdapterConfig(referenceImage.config)) {
        return;
      }
      referenceImage.config.beginEndStepPct = beginEndStepPct;
    },
    rgRefImageIPAdapterMethodChanged: (
      state,
      action: PayloadAction<
        EntityIdentifierPayload<{ referenceImageId: string; method: IPMethodV2 }, 'regional_guidance'>
      >
    ) => {
      const { entityIdentifier, referenceImageId, method } = action.payload;
      const referenceImage = selectRegionalGuidanceReferenceImage(state, entityIdentifier, referenceImageId);
      if (!referenceImage) {
        return;
      }
      if (!isIPAdapterConfig(referenceImage.config)) {
        return;
      }
      referenceImage.config.method = method;
    },
    rgRefImageFLUXReduxImageInfluenceChanged: (
      state,
      action: PayloadAction<
        EntityIdentifierPayload<
          { referenceImageId: string; imageInfluence: FLUXReduxImageInfluence },
          'regional_guidance'
        >
      >
    ) => {
      const { entityIdentifier, referenceImageId, imageInfluence } = action.payload;
      const referenceImage = selectRegionalGuidanceReferenceImage(state, entityIdentifier, referenceImageId);
      if (!referenceImage) {
        return;
      }
      if (!isFLUXReduxConfig(referenceImage.config)) {
        return;
      }

      referenceImage.config.imageInfluence = imageInfluence;
    },
    rgRefImageModelChanged: (
      state,
      action: PayloadAction<
        EntityIdentifierPayload<
          {
            referenceImageId: string;
            modelConfig: IPAdapterModelConfig | FLUXReduxModelConfig | null;
          },
          'regional_guidance'
        >
      >
    ) => {
      const { entityIdentifier, referenceImageId, modelConfig } = action.payload;
      const referenceImage = selectRegionalGuidanceReferenceImage(state, entityIdentifier, referenceImageId);
      if (!referenceImage) {
        return;
      }

      if (!modelConfig) {
        referenceImage.config.model = null;
        return;
      }

      if (isIPAdapterConfig(referenceImage.config) && isFluxReduxModelConfig(modelConfig)) {
        // Switching from ip_adapter to flux_redux
        referenceImage.config = {
          ...initialFLUXRedux,
          image: referenceImage.config.image,
          model: zModelIdentifierField.parse(modelConfig),
        };
        return;
      }

      if (isFLUXReduxConfig(referenceImage.config) && isIPAdapterModelConfig(modelConfig)) {
        // Switching from flux_redux to ip_adapter
        referenceImage.config = {
          ...initialIPAdapter,
          image: referenceImage.config.image,
          model: zModelIdentifierField.parse(modelConfig),
        };
        return;
      }

      if (isIPAdapterConfig(referenceImage.config)) {
        referenceImage.config.model = zModelIdentifierField.parse(modelConfig);

        // Ensure that the IP Adapter model is compatible with the CLIP Vision model
        if (referenceImage.config.model?.base === 'flux') {
          referenceImage.config.clipVisionModel = 'ViT-L';
        } else if (referenceImage.config.clipVisionModel === 'ViT-L') {
          // Fall back to ViT-H (ViT-G would also work)
          referenceImage.config.clipVisionModel = 'ViT-H';
        }
      }
    },
    rgRefImageIPAdapterCLIPVisionModelChanged: (
      state,
      action: PayloadAction<
        EntityIdentifierPayload<{ referenceImageId: string; clipVisionModel: CLIPVisionModelV2 }, 'regional_guidance'>
      >
    ) => {
      const { entityIdentifier, referenceImageId, clipVisionModel } = action.payload;
      const referenceImage = selectRegionalGuidanceReferenceImage(state, entityIdentifier, referenceImageId);
      if (!referenceImage) {
        return;
      }
      if (!isIPAdapterConfig(referenceImage.config)) {
        return;
      }
      referenceImage.config.clipVisionModel = clipVisionModel;
    },
    //#region Inpaint mask
    inpaintMaskAdded: {
      reducer: (
        state,
        action: PayloadAction<{
          id: string;
          overrides?: Partial<CanvasInpaintMaskState>;
          isSelected?: boolean;
          isBookmarked?: boolean;
          mergedEntitiesToDelete?: string[];
        }>
      ) => {
        const { id, overrides, isSelected, isBookmarked, mergedEntitiesToDelete = [] } = action.payload;

        const entityState = getInpaintMaskState(id, overrides);

        state.inpaintMasks.entities.push(entityState);

        if (mergedEntitiesToDelete.length > 0) {
          state.inpaintMasks.entities = state.inpaintMasks.entities.filter(
            (entity) => !mergedEntitiesToDelete.includes(entity.id)
          );
        }
        const entityIdentifier = getEntityIdentifier(entityState);

        if (isSelected || mergedEntitiesToDelete.length > 0) {
          state.selectedEntityIdentifier = entityIdentifier;
        }

        if (isBookmarked) {
          state.bookmarkedEntityIdentifier = entityIdentifier;
        }
      },
      prepare: (payload?: {
        overrides?: Partial<CanvasInpaintMaskState>;
        isSelected?: boolean;
        isBookmarked?: boolean;
        mergedEntitiesToDelete?: string[];
      }) => ({
        payload: { ...payload, id: getPrefixedId('inpaint_mask') },
      }),
    },
    inpaintMaskRecalled: (state, action: PayloadAction<{ data: CanvasInpaintMaskState }>) => {
      const { data } = action.payload;
      state.inpaintMasks.entities = [data];
      state.selectedEntityIdentifier = { type: 'inpaint_mask', id: data.id };
    },
    inpaintMaskNoiseAdded: (state, action: PayloadAction<EntityIdentifierPayload<void, 'inpaint_mask'>>) => {
      const { entityIdentifier } = action.payload;
      const entity = selectEntity(state, entityIdentifier);
      if (entity && entity.type === 'inpaint_mask') {
        entity.noiseLevel = 0.15; // Default noise level
      }
    },
    inpaintMaskNoiseChanged: (
      state,
      action: PayloadAction<EntityIdentifierPayload<{ noiseLevel: number }, 'inpaint_mask'>>
    ) => {
      const { entityIdentifier, noiseLevel } = action.payload;
      const entity = selectEntity(state, entityIdentifier);
      if (entity && entity.type === 'inpaint_mask') {
        entity.noiseLevel = noiseLevel;
      }
    },
    inpaintMaskNoiseDeleted: (state, action: PayloadAction<EntityIdentifierPayload<void, 'inpaint_mask'>>) => {
      const { entityIdentifier } = action.payload;
      const entity = selectEntity(state, entityIdentifier);
      if (entity && entity.type === 'inpaint_mask') {
        entity.noiseLevel = undefined;
      }
    },
    inpaintMaskConvertedToRegionalGuidance: {
      reducer: (
        state,
        action: PayloadAction<
          EntityIdentifierPayload<
            { newId: string; overrides?: Partial<CanvasRegionalGuidanceState>; replace?: boolean },
            'inpaint_mask'
          >
        >
      ) => {
        const { entityIdentifier, newId, overrides, replace } = action.payload;
        const layer = selectEntity(state, entityIdentifier);
        if (!layer) {
          return;
        }

        // Convert the inpaint mask to regional guidance
        const regionalGuidanceState = converters.inpaintMask.toRegionalGuidance(newId, layer, overrides);

        if (replace) {
          // Remove the inpaint mask
          state.inpaintMasks.entities = state.inpaintMasks.entities.filter((layer) => layer.id !== entityIdentifier.id);
        }

        // Add the new regional guidance
        state.regionalGuidance.entities.push(regionalGuidanceState);

        state.selectedEntityIdentifier = { type: regionalGuidanceState.type, id: regionalGuidanceState.id };
      },
      prepare: (
        payload: EntityIdentifierPayload<
          { overrides?: Partial<CanvasRegionalGuidanceState>; replace?: boolean } | undefined,
          'inpaint_mask'
        >
      ) => ({
        payload: { ...payload, newId: getPrefixedId('regional_guidance') },
      }),
    },
    inpaintMaskDenoiseLimitAdded: (state, action: PayloadAction<EntityIdentifierPayload<void, 'inpaint_mask'>>) => {
      const { entityIdentifier } = action.payload;
      const entity = selectEntity(state, entityIdentifier);
      if (entity && entity.type === 'inpaint_mask') {
        entity.denoiseLimit = 1.0; // Default denoise limit
      }
    },
    inpaintMaskDenoiseLimitChanged: (
      state,
      action: PayloadAction<EntityIdentifierPayload<{ denoiseLimit: number }, 'inpaint_mask'>>
    ) => {
      const { entityIdentifier, denoiseLimit } = action.payload;
      const entity = selectEntity(state, entityIdentifier);
      if (entity && entity.type === 'inpaint_mask') {
        entity.denoiseLimit = denoiseLimit;
      }
    },
    inpaintMaskDenoiseLimitDeleted: (state, action: PayloadAction<EntityIdentifierPayload<void, 'inpaint_mask'>>) => {
      const { entityIdentifier } = action.payload;
      const entity = selectEntity(state, entityIdentifier);
      if (entity && entity.type === 'inpaint_mask') {
        entity.denoiseLimit = undefined;
      }
    },
    //#region BBox
    bboxScaledWidthChanged: (state, action: PayloadAction<number>) => {
      const gridSize = getGridSize(state.bbox.modelBase);

      state.bbox.scaledSize.width = roundToMultiple(action.payload, gridSize);

      if (state.bbox.aspectRatio.isLocked) {
        state.bbox.scaledSize.height = roundToMultiple(
          state.bbox.scaledSize.width / state.bbox.aspectRatio.value,
          gridSize
        );
      }
    },
    bboxScaledHeightChanged: (state, action: PayloadAction<number>) => {
      const gridSize = getGridSize(state.bbox.modelBase);

      state.bbox.scaledSize.height = roundToMultiple(action.payload, gridSize);

      if (state.bbox.aspectRatio.isLocked) {
        state.bbox.scaledSize.width = roundToMultiple(
          state.bbox.scaledSize.height * state.bbox.aspectRatio.value,
          gridSize
        );
      }
    },
    bboxScaleMethodChanged: (state, action: PayloadAction<BoundingBoxScaleMethod>) => {
      state.bbox.scaleMethod = action.payload;
      syncScaledSize(state);
    },
    bboxChangedFromCanvas: (state, action: PayloadAction<IRect>) => {
      const newBboxRect = action.payload;
      const oldBboxRect = state.bbox.rect;

      state.bbox.rect = newBboxRect;

      if (newBboxRect.width === oldBboxRect.width && newBboxRect.height === oldBboxRect.height) {
        return;
      }

      const oldAspectRatio = state.bbox.aspectRatio.value;
      const newAspectRatio = newBboxRect.width / newBboxRect.height;

      if (oldAspectRatio === newAspectRatio) {
        return;
      }

      // TODO(psyche): Figure out a way to handle this without resetting the aspect ratio on every change.
      // This action is dispatched when the user resizes or moves the bbox from the canvas. For now, when the user
      // resizes the bbox from the canvas, we unlock the aspect ratio.
      state.bbox.aspectRatio.value = state.bbox.rect.width / state.bbox.rect.height;
      state.bbox.aspectRatio.id = 'Free';

      syncScaledSize(state);
    },
    bboxWidthChanged: (
      state,
      action: PayloadAction<{ width: number; updateAspectRatio?: boolean; clamp?: boolean }>
    ) => {
      const { width, updateAspectRatio, clamp } = action.payload;
      const gridSize = getGridSize(state.bbox.modelBase);
      state.bbox.rect.width = clamp ? Math.max(roundDownToMultiple(width, gridSize), 64) : width;

      if (state.bbox.aspectRatio.isLocked) {
        state.bbox.rect.height = roundToMultiple(state.bbox.rect.width / state.bbox.aspectRatio.value, gridSize);
      }

      if (updateAspectRatio || !state.bbox.aspectRatio.isLocked) {
        state.bbox.aspectRatio.value = state.bbox.rect.width / state.bbox.rect.height;
        state.bbox.aspectRatio.id = 'Free';
        state.bbox.aspectRatio.isLocked = false;
      }

      syncScaledSize(state);
    },
    bboxHeightChanged: (
      state,
      action: PayloadAction<{ height: number; updateAspectRatio?: boolean; clamp?: boolean }>
    ) => {
      const { height, updateAspectRatio, clamp } = action.payload;
      const gridSize = getGridSize(state.bbox.modelBase);
      state.bbox.rect.height = clamp ? Math.max(roundDownToMultiple(height, gridSize), 64) : height;

      if (state.bbox.aspectRatio.isLocked) {
        state.bbox.rect.width = roundToMultiple(state.bbox.rect.height * state.bbox.aspectRatio.value, gridSize);
      }

      if (updateAspectRatio || !state.bbox.aspectRatio.isLocked) {
        state.bbox.aspectRatio.value = state.bbox.rect.width / state.bbox.rect.height;
        state.bbox.aspectRatio.id = 'Free';
        state.bbox.aspectRatio.isLocked = false;
      }

      syncScaledSize(state);
    },
    bboxAspectRatioLockToggled: (state) => {
      state.bbox.aspectRatio.isLocked = !state.bbox.aspectRatio.isLocked;
      syncScaledSize(state);
    },
    bboxAspectRatioIdChanged: (state, action: PayloadAction<{ id: AspectRatioID }>) => {
      const { id } = action.payload;
      state.bbox.aspectRatio.id = id;
      if (id === 'Free') {
        state.bbox.aspectRatio.isLocked = false;
      } else if (
        (state.bbox.modelBase === 'imagen3' || state.bbox.modelBase === 'imagen4') &&
        isImagenAspectRatioID(id)
      ) {
        const { width, height } = IMAGEN_ASPECT_RATIOS[id];
        state.bbox.rect.width = width;
        state.bbox.rect.height = height;
        state.bbox.aspectRatio.value = state.bbox.rect.width / state.bbox.rect.height;
        state.bbox.aspectRatio.isLocked = true;
      } else if (state.bbox.modelBase === 'chatgpt-4o' && isChatGPT4oAspectRatioID(id)) {
        const { width, height } = CHATGPT_ASPECT_RATIOS[id];
        state.bbox.rect.width = width;
        state.bbox.rect.height = height;
        state.bbox.aspectRatio.value = state.bbox.rect.width / state.bbox.rect.height;
        state.bbox.aspectRatio.isLocked = true;
      } else if (state.bbox.modelBase === 'flux-kontext' && isFluxKontextAspectRatioID(id)) {
        const { width, height } = FLUX_KONTEXT_ASPECT_RATIOS[id];
        state.bbox.rect.width = width;
        state.bbox.rect.height = height;
        state.bbox.aspectRatio.value = state.bbox.rect.width / state.bbox.rect.height;
        state.bbox.aspectRatio.isLocked = true;
      } else {
        state.bbox.aspectRatio.isLocked = true;
        state.bbox.aspectRatio.value = ASPECT_RATIO_MAP[id].ratio;
        const { width, height } = calculateNewSize(
          state.bbox.aspectRatio.value,
          state.bbox.rect.width * state.bbox.rect.height,
          state.bbox.modelBase
        );
        state.bbox.rect.width = width;
        state.bbox.rect.height = height;
      }

      syncScaledSize(state);
    },
    bboxDimensionsSwapped: (state) => {
      state.bbox.aspectRatio.value = 1 / state.bbox.aspectRatio.value;
      if (state.bbox.aspectRatio.id === 'Free') {
        const newWidth = state.bbox.rect.height;
        const newHeight = state.bbox.rect.width;
        state.bbox.rect.width = newWidth;
        state.bbox.rect.height = newHeight;
      } else {
        const { width, height } = calculateNewSize(
          state.bbox.aspectRatio.value,
          state.bbox.rect.width * state.bbox.rect.height,
          state.bbox.modelBase
        );
        state.bbox.rect.width = width;
        state.bbox.rect.height = height;
        state.bbox.aspectRatio.id = ASPECT_RATIO_MAP[state.bbox.aspectRatio.id].inverseID;
      }

      syncScaledSize(state);
    },
    bboxSizeOptimized: (state) => {
      const optimalDimension = getOptimalDimension(state.bbox.modelBase);
      if (state.bbox.aspectRatio.isLocked) {
        const { width, height } = calculateNewSize(
          state.bbox.aspectRatio.value,
          optimalDimension * optimalDimension,
          state.bbox.modelBase
        );
        state.bbox.rect.width = width;
        state.bbox.rect.height = height;
      } else {
        state.bbox.aspectRatio = deepClone(DEFAULT_ASPECT_RATIO_CONFIG);
        state.bbox.rect.width = optimalDimension;
        state.bbox.rect.height = optimalDimension;
      }

      syncScaledSize(state);
    },
    bboxSyncedToOptimalDimension: (state) => {
      const optimalDimension = getOptimalDimension(state.bbox.modelBase);

      if (!getIsSizeOptimal(state.bbox.rect.width, state.bbox.rect.height, state.bbox.modelBase)) {
        const bboxDims = calculateNewSize(
          state.bbox.aspectRatio.value,
          optimalDimension * optimalDimension,
          state.bbox.modelBase
        );
        state.bbox.rect.width = bboxDims.width;
        state.bbox.rect.height = bboxDims.height;
        syncScaledSize(state);
      }
    },
    //#region Shared entity
    entitySelected: (state, action: PayloadAction<EntityIdentifierPayload>) => {
      const { entityIdentifier } = action.payload;
      const entity = selectEntity(state, entityIdentifier);
      if (!entity) {
        // Cannot select a non-existent entity
        return;
      }
      state.selectedEntityIdentifier = entityIdentifier;
    },
    bookmarkedEntityChanged: (state, action: PayloadAction<{ entityIdentifier: CanvasEntityIdentifier | null }>) => {
      const { entityIdentifier } = action.payload;
      if (!entityIdentifier) {
        state.bookmarkedEntityIdentifier = null;
        return;
      }
      const entity = selectEntity(state, entityIdentifier);
      if (!entity) {
        // Cannot select a non-existent entity
        return;
      }
      state.bookmarkedEntityIdentifier = entityIdentifier;
    },
    entityNameChanged: (state, action: PayloadAction<EntityIdentifierPayload<{ name: string | null }>>) => {
      const { entityIdentifier, name } = action.payload;
      const entity = selectEntity(state, entityIdentifier);
      if (!entity) {
        return;
      }
      entity.name = name;
    },
    entityReset: (state, action: PayloadAction<EntityIdentifierPayload>) => {
      const { entityIdentifier } = action.payload;
      const entity = selectEntity(state, entityIdentifier);
      if (!entity) {
        return;
      }
      entity.isEnabled = true;
      entity.objects = [];
      entity.position = { x: 0, y: 0 };
    },
    entityDuplicated: (state, action: PayloadAction<EntityIdentifierPayload>) => {
      const { entityIdentifier } = action.payload;
      const entity = selectEntity(state, entityIdentifier);
      if (!entity) {
        return;
      }

      const newEntity = deepClone(entity);
      if (newEntity.name) {
        newEntity.name = `${newEntity.name} (Copy)`;
      }
      switch (newEntity.type) {
        case 'raster_layer':
          newEntity.id = getPrefixedId('raster_layer');
          state.rasterLayers.entities.push(newEntity);
          break;
        case 'control_layer':
          newEntity.id = getPrefixedId('control_layer');
          state.controlLayers.entities.push(newEntity);
          break;
        case 'regional_guidance':
          newEntity.id = getPrefixedId('regional_guidance');
          for (const refImage of newEntity.referenceImages) {
            refImage.id = getPrefixedId('regional_guidance_ip_adapter');
          }
          state.regionalGuidance.entities.push(newEntity);
          break;
        case 'inpaint_mask':
          newEntity.id = getPrefixedId('inpaint_mask');
          state.inpaintMasks.entities.push(newEntity);
          break;
      }

      state.selectedEntityIdentifier = getEntityIdentifier(newEntity);
    },
    entityIsEnabledToggled: (state, action: PayloadAction<EntityIdentifierPayload>) => {
      const { entityIdentifier } = action.payload;
      const entity = selectEntity(state, entityIdentifier);
      if (!entity) {
        return;
      }
      entity.isEnabled = !entity.isEnabled;
    },
    entityIsLockedToggled: (state, action: PayloadAction<EntityIdentifierPayload>) => {
      const { entityIdentifier } = action.payload;
      const entity = selectEntity(state, entityIdentifier);
      if (!entity) {
        return;
      }
      entity.isLocked = !entity.isLocked;
    },
    entityFillColorChanged: (
      state,
      action: PayloadAction<EntityIdentifierPayload<{ color: RgbColor }, 'inpaint_mask' | 'regional_guidance'>>
    ) => {
      const { color, entityIdentifier } = action.payload;
      const entity = selectEntity(state, entityIdentifier);
      if (!entity) {
        return;
      }
      entity.fill.color = color;
    },
    entityFillStyleChanged: (
      state,
      action: PayloadAction<EntityIdentifierPayload<{ style: FillStyle }, 'inpaint_mask' | 'regional_guidance'>>
    ) => {
      const { style, entityIdentifier } = action.payload;
      const entity = selectEntity(state, entityIdentifier);
      if (!entity) {
        return;
      }
      entity.fill.style = style;
    },
    entityMovedTo: (state, action: PayloadAction<EntityMovedToPayload>) => {
      const { entityIdentifier, position } = action.payload;
      const entity = selectEntity(state, entityIdentifier);
      if (!entity) {
        return;
      }

      entity.position = position;
    },
    entityMovedBy: (state, action: PayloadAction<EntityMovedByPayload>) => {
      const { entityIdentifier, offset } = action.payload;
      const entity = selectEntity(state, entityIdentifier);
      if (!entity) {
        return;
      }

      entity.position.x += offset.x;
      entity.position.y += offset.y;
    },
    entityRasterized: (state, action: PayloadAction<EntityRasterizedPayload>) => {
      const { entityIdentifier, imageObject, position, replaceObjects, isSelected } = action.payload;
      const entity = selectEntity(state, entityIdentifier);
      if (!entity) {
        return;
      }

      if (replaceObjects) {
        entity.objects = [imageObject];
        entity.position = position;
      }

      if (isSelected) {
        state.selectedEntityIdentifier = entityIdentifier;
      }
    },
    entityBrushLineAdded: (state, action: PayloadAction<EntityBrushLineAddedPayload>) => {
      const { entityIdentifier, brushLine } = action.payload;
      const entity = selectEntity(state, entityIdentifier);
      if (!entity) {
        return;
      }

      // TODO(psyche): If we add the object without splatting, the renderer will see it as the same object and not
      // re-render it (reference equality check). I don't like this behaviour.
      entity.objects.push({
        ...brushLine,
        // If the brush line is not pressure sensitive, we simplify the points to reduce the size of the state
        points: brushLine.type === 'brush_line' ? simplifyFlatNumbersArray(brushLine.points) : brushLine.points,
      });
    },
    entityEraserLineAdded: (state, action: PayloadAction<EntityEraserLineAddedPayload>) => {
      const { entityIdentifier, eraserLine } = action.payload;
      const entity = selectEntity(state, entityIdentifier);
      if (!entity) {
        return;
      }

      // TODO(psyche): If we add the object without splatting, the renderer will see it as the same object and not
      // re-render it (reference equality check). I don't like this behaviour.
      entity.objects.push({
        ...eraserLine,
        // If the brush line is not pressure sensitive, we simplify the points to reduce the size of the state
        points: eraserLine.type === 'eraser_line' ? simplifyFlatNumbersArray(eraserLine.points) : eraserLine.points,
      });
    },
    entityRectAdded: (state, action: PayloadAction<EntityRectAddedPayload>) => {
      const { entityIdentifier, rect } = action.payload;
      const entity = selectEntity(state, entityIdentifier);
      if (!entity) {
        return;
      }

      // TODO(psyche): If we add the object without splatting, the renderer will see it as the same object and not
      // re-render it (reference equality check). I don't like this behaviour.
      entity.objects.push({ ...rect });
    },
    entityDeleted: (state, action: PayloadAction<EntityIdentifierPayload>) => {
      const { entityIdentifier } = action.payload;

      let selectedEntityIdentifier: CanvasState['selectedEntityIdentifier'] = null;
      const allEntities = selectAllEntities(state);
      const index = allEntities.findIndex((entity) => entity.id === entityIdentifier.id);
      const nextIndex = allEntities.length > 1 ? (index + 1) % allEntities.length : -1;
      if (nextIndex !== -1) {
        const nextEntity = allEntities[nextIndex];
        if (nextEntity) {
          selectedEntityIdentifier = getEntityIdentifier(nextEntity);
        }
      }

      switch (entityIdentifier.type) {
        case 'raster_layer':
          state.rasterLayers.entities = state.rasterLayers.entities.filter((layer) => layer.id !== entityIdentifier.id);
          break;
        case 'control_layer':
          state.controlLayers.entities = state.controlLayers.entities.filter((rg) => rg.id !== entityIdentifier.id);
          break;
        case 'regional_guidance':
          state.regionalGuidance.entities = state.regionalGuidance.entities.filter(
            (rg) => rg.id !== entityIdentifier.id
          );
          break;
        case 'inpaint_mask':
          state.inpaintMasks.entities = state.inpaintMasks.entities.filter((rg) => rg.id !== entityIdentifier.id);
          break;
      }

      state.selectedEntityIdentifier = selectedEntityIdentifier;
    },
    entityArrangedForwardOne: (state, action: PayloadAction<EntityIdentifierPayload>) => {
      const { entityIdentifier } = action.payload;
      const entity = selectEntity(state, entityIdentifier);
      if (!entity) {
        return;
      }
      moveOneToEnd(selectAllEntitiesOfType(state, entity.type), entity);
    },
    entityArrangedToFront: (state, action: PayloadAction<EntityIdentifierPayload>) => {
      const { entityIdentifier } = action.payload;
      const entity = selectEntity(state, entityIdentifier);
      if (!entity) {
        return;
      }
      moveToEnd(selectAllEntitiesOfType(state, entity.type), entity);
    },
    entityArrangedBackwardOne: (state, action: PayloadAction<EntityIdentifierPayload>) => {
      const { entityIdentifier } = action.payload;
      const entity = selectEntity(state, entityIdentifier);
      if (!entity) {
        return;
      }
      moveOneToStart(selectAllEntitiesOfType(state, entity.type), entity);
    },
    entityArrangedToBack: (state, action: PayloadAction<EntityIdentifierPayload>) => {
      const { entityIdentifier } = action.payload;
      const entity = selectEntity(state, entityIdentifier);
      if (!entity) {
        return;
      }
      moveToStart(selectAllEntitiesOfType(state, entity.type), entity);
    },
    entitiesReordered: <T extends CanvasEntityType>(
      state: CanvasState,
      action: PayloadAction<{ type: T; entityIdentifiers: CanvasEntityIdentifier<T>[] }>
    ) => {
      const { type, entityIdentifiers } = action.payload;

      switch (type) {
        case 'raster_layer': {
          state.rasterLayers.entities = reorderEntities(
            state.rasterLayers.entities,
            entityIdentifiers as CanvasEntityIdentifier<'raster_layer'>[]
          );
          break;
        }
        case 'control_layer':
          state.controlLayers.entities = reorderEntities(
            state.controlLayers.entities,
            entityIdentifiers as CanvasEntityIdentifier<'control_layer'>[]
          );
          break;
        case 'inpaint_mask':
          state.inpaintMasks.entities = reorderEntities(
            state.inpaintMasks.entities,
            entityIdentifiers as CanvasEntityIdentifier<'inpaint_mask'>[]
          );
          break;
        case 'regional_guidance':
          state.regionalGuidance.entities = reorderEntities(
            state.regionalGuidance.entities,
            entityIdentifiers as CanvasEntityIdentifier<'regional_guidance'>[]
          );
          break;
      }
    },
    entityOpacityChanged: (state, action: PayloadAction<EntityIdentifierPayload<{ opacity: number }>>) => {
      const { entityIdentifier, opacity } = action.payload;
      const entity = selectEntity(state, entityIdentifier);
      if (!entity) {
        return;
      }
      entity.opacity = opacity;
    },
    allEntitiesOfTypeIsHiddenToggled: (state, action: PayloadAction<{ type: CanvasEntityIdentifier['type'] }>) => {
      const { type } = action.payload;

      switch (type) {
        case 'raster_layer':
          state.rasterLayers.isHidden = !state.rasterLayers.isHidden;
          break;
        case 'control_layer':
          state.controlLayers.isHidden = !state.controlLayers.isHidden;
          break;
        case 'inpaint_mask':
          state.inpaintMasks.isHidden = !state.inpaintMasks.isHidden;
          break;
        case 'regional_guidance':
          state.regionalGuidance.isHidden = !state.regionalGuidance.isHidden;
          break;
      }
    },
    allNonRasterLayersIsHiddenToggled: (state) => {
      const hasVisibleNonRasterLayers =
        !state.controlLayers.isHidden || !state.inpaintMasks.isHidden || !state.regionalGuidance.isHidden;

      const shouldHide = hasVisibleNonRasterLayers;

      state.controlLayers.isHidden = shouldHide;
      state.inpaintMasks.isHidden = shouldHide;
      state.regionalGuidance.isHidden = shouldHide;
    },
    allEntitiesDeleted: (state) => {
      // Deleting all entities is equivalent to resetting the state for each entity type
      const initialState = getInitialCanvasState();
      state.rasterLayers = initialState.rasterLayers;
      state.controlLayers = initialState.controlLayers;
      state.inpaintMasks = initialState.inpaintMasks;
      state.regionalGuidance = initialState.regionalGuidance;
    },
    canvasMetadataRecalled: (state, action: PayloadAction<CanvasMetadata>) => {
      const { controlLayers, inpaintMasks, rasterLayers, regionalGuidance } = action.payload;
      state.controlLayers.entities = controlLayers;
      state.inpaintMasks.entities = inpaintMasks;
      state.rasterLayers.entities = rasterLayers;
      state.regionalGuidance.entities = regionalGuidance;
      return state;
    },
    canvasUndo: () => {},
    canvasRedo: () => {},
    canvasClearHistory: () => {},
  },
  extraReducers(builder) {
    builder.addCase(canvasReset, (state) => {
      return resetState(state);
    });
    builder.addCase(modelChanged, (state, action) => {
      const { model } = action.payload;
      /**
       * Because the bbox depends in part on the model, it needs to be in sync with the model. However, due to
       * complications with managing undo/redo history, we need to store the model in a separate slice from the canvas
       * state.
       *
       * Unfortunately, this means we need to manually sync the model with the canvas state. We only care about the
       * model base, so we only need to update the bbox's modelBase field.
       *
       * When we do this, we also want to update the bbox's dimensions - but only if we are not staging images on the
       * canvas, during which time the bbox must stay the same.
       *
       * Unfortunately (again), the staging state is in a different slice, to prevent issues with undo/redo history.
       *
       * There's some fanagling we must do to handle this correctly:
       * - Store the model base in this slice, so that we can access it when the user changes the bbox dimensions.
       * - Avoid updating the bbox dimensions when we are staging - only update the model base.
       * - Provide a separate action that will update the bbox dimensions and be careful to not dispatch it when staging.
       */
      const base = model?.base;
      if (isMainModelBase(base) && state.bbox.modelBase !== base) {
        state.bbox.modelBase = base;
        if (API_BASE_MODELS.includes(base)) {
          state.bbox.aspectRatio.isLocked = true;
          state.bbox.aspectRatio.value = 1;
          state.bbox.aspectRatio.id = '1:1';
          state.bbox.rect.width = 1024;
          state.bbox.rect.height = 1024;
        }
        syncScaledSize(state);
      }
    });
  },
});

const resetState = (state: CanvasState) => {
  const newState = getInitialCanvasState();

  // We need to retain the optimal dimension across resets, as it is changed only when the model changes. Copy it
  // from the old state, then recalculate the bbox size & scaled size.
  newState.bbox.modelBase = state.bbox.modelBase;
  const optimalDimension = getOptimalDimension(newState.bbox.modelBase);
  const rect = calculateNewSize(
    newState.bbox.aspectRatio.value,
    optimalDimension * optimalDimension,
    newState.bbox.modelBase
  );
  newState.bbox.rect.width = rect.width;
  newState.bbox.rect.height = rect.height;
  syncScaledSize(newState);

  return newState;
};

export const {
  canvasMetadataRecalled,
  canvasUndo,
  canvasRedo,
  canvasClearHistory,
  // All entities
  entitySelected,
  bookmarkedEntityChanged,
  entityNameChanged,
  entityReset,
  entityIsEnabledToggled,
  entityIsLockedToggled,
  entityFillColorChanged,
  entityFillStyleChanged,
  entityMovedTo,
  entityMovedBy,
  entityDuplicated,
  entityRasterized,
  entityBrushLineAdded,
  entityEraserLineAdded,
  entityRectAdded,
  entityDeleted,
  entityArrangedForwardOne,
  entityArrangedToFront,
  entityArrangedBackwardOne,
  entityArrangedToBack,
  entityOpacityChanged,
  entitiesReordered,
  allEntitiesOfTypeIsHiddenToggled,
  allNonRasterLayersIsHiddenToggled,
  // bbox
  bboxChangedFromCanvas,
  bboxScaledWidthChanged,
  bboxScaledHeightChanged,
  bboxScaleMethodChanged,
  bboxWidthChanged,
  bboxHeightChanged,
  bboxAspectRatioLockToggled,
  bboxAspectRatioIdChanged,
  bboxDimensionsSwapped,
  bboxSizeOptimized,
  bboxSyncedToOptimalDimension,
  // Raster layers
  rasterLayerAdded,
  // rasterLayerRecalled,
  rasterLayerConvertedToControlLayer,
  rasterLayerConvertedToInpaintMask,
  rasterLayerConvertedToRegionalGuidance,
  // Control layers
  controlLayerAdded,
  // controlLayerRecalled,
  controlLayerConvertedToRasterLayer,
  controlLayerConvertedToInpaintMask,
  controlLayerConvertedToRegionalGuidance,
  controlLayerModelChanged,
  controlLayerControlModeChanged,
  controlLayerWeightChanged,
  controlLayerBeginEndStepPctChanged,
  controlLayerWithTransparencyEffectToggled,
  // Regions
  rgAdded,
  // rgRecalled,
  rgConvertedToInpaintMask,
  rgPositivePromptChanged,
  rgNegativePromptChanged,
  rgAutoNegativeToggled,
  rgRefImageAdded,
  rgRefImageDeleted,
  rgRefImageImageChanged,
  rgRefImageIPAdapterWeightChanged,
  rgRefImageIPAdapterBeginEndStepPctChanged,
  rgRefImageIPAdapterMethodChanged,
  rgRefImageModelChanged,
  rgRefImageIPAdapterCLIPVisionModelChanged,
  rgRefImageFLUXReduxImageInfluenceChanged,
  // Inpaint mask
  inpaintMaskAdded,
  inpaintMaskConvertedToRegionalGuidance,
  inpaintMaskNoiseAdded,
  inpaintMaskNoiseChanged,
  inpaintMaskNoiseDeleted,
  inpaintMaskDenoiseLimitAdded,
  inpaintMaskDenoiseLimitChanged,
  inpaintMaskDenoiseLimitDeleted,
  // inpaintMaskRecalled,
} = canvasSlice.actions;

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
const migrate = (state: any): any => {
  return state;
};

export const canvasPersistConfig: PersistConfig<CanvasState> = {
  name: canvasSlice.name,
  initialState: getInitialCanvasState(),
  migrate,
  persistDenylist: [],
};

const syncScaledSize = (state: CanvasState) => {
  if (API_BASE_MODELS.includes(state.bbox.modelBase)) {
    // Imagen3 has fixed sizes. Scaled bbox is not supported.
    return;
  }
  if (state.bbox.scaleMethod === 'auto') {
    // Sync both aspect ratio and size
    const { width, height } = state.bbox.rect;
    state.bbox.scaledSize = getScaledBoundingBoxDimensions({ width, height }, state.bbox.modelBase);
  } else if (state.bbox.scaleMethod === 'manual' && state.bbox.aspectRatio.isLocked) {
    // Only sync the aspect ratio if manual & locked
    state.bbox.scaledSize = calculateNewSize(
      state.bbox.aspectRatio.value,
      state.bbox.scaledSize.width * state.bbox.scaledSize.height,
      state.bbox.modelBase
    );
  }
};

let filter = true;

export const canvasUndoableConfig: UndoableOptions<CanvasState, UnknownAction> = {
  limit: 64,
  undoType: canvasUndo.type,
  redoType: canvasRedo.type,
  clearHistoryType: canvasClearHistory.type,
  filter: (action, _state, _history) => {
    // Ignore all actions from other slices
    if (!action.type.startsWith(canvasSlice.name)) {
      return false;
    }
    // Throttle rapid actions of the same type
    filter = actionsThrottlingFilter(action);
    return filter;
  },
  // This is pretty spammy, leave commented out unless you need it
  // debug: import.meta.env.MODE === 'development',
};

const doNotGroupMatcher = isAnyOf(entityBrushLineAdded, entityEraserLineAdded, entityRectAdded);

// Store rapid actions of the same type at most once every x time.
// See: https://github.com/omnidan/redux-undo/blob/master/examples/throttled-drag/util/undoFilter.js
const THROTTLE_MS = 1000;
let ignoreRapid = false;
let prevActionType: string | null = null;
function actionsThrottlingFilter(action: UnknownAction) {
  // If the actions are of a different type, reset the throttle and allow the action
  if (action.type !== prevActionType || doNotGroupMatcher(action)) {
    ignoreRapid = false;
    prevActionType = action.type;
    return true;
  }
  // Else, if the actions are of the same type, throttle them. Ignore the action if the flag is set.
  if (ignoreRapid) {
    return false;
  }
  // We are allowing this action - set the flag and a timeout to clear it.
  ignoreRapid = true;
  window.setTimeout(() => {
    ignoreRapid = false;
  }, THROTTLE_MS);
  return true;
}

const reorderEntities = <T extends CanvasEntityType>(
  entities: CanvasEntityStateFromType<T>[],
  sortedEntityIdentifiers: CanvasEntityIdentifier<T>[]
) => {
  const sortedEntities: CanvasEntityStateFromType<T>[] = [];
  for (const { id } of sortedEntityIdentifiers.toReversed()) {
    const entity = entities.find((entity) => entity.id === id);
    if (entity) {
      sortedEntities.push(entity);
    }
  }
  return sortedEntities;
};
