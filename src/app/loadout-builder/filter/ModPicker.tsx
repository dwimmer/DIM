import { D2ManifestDefinitions } from 'app/destiny2/d2-definitions';
import { settingsSelector } from 'app/dim-api/selectors';
import { t } from 'app/i18next-t';
import { InventoryBuckets } from 'app/inventory/inventory-buckets';
import { DimItem, PluggableInventoryItemDefinition } from 'app/inventory/item-types';
import {
  allItemsSelector,
  bucketsSelector,
  profileResponseSelector,
} from 'app/inventory/selectors';
import { isPluggableItem } from 'app/inventory/store/sockets';
import { plugIsInsertable } from 'app/item-popup/SocketDetails';
import { itemsForPlugSet } from 'app/records/plugset-helpers';
import { escapeRegExp } from 'app/search/search-filters/freeform';
import { SearchFilterRef } from 'app/search/SearchBar';
import { AppIcon, searchIcon } from 'app/shell/icons';
import { RootState } from 'app/store/types';
import { isArmor2Mod } from 'app/utils/item-utils';
import { DestinyClass, DestinyProfileResponse } from 'bungie-api-ts/destiny2';
import _ from 'lodash';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { connect } from 'react-redux';
import { createSelector } from 'reselect';
import Sheet from '../../dim-ui/Sheet';
import '../../item-picker/ItemPicker.scss';
import { sortModGroups, sortMods } from '../mod-utils';
import { PluggableItemsByPlugCategoryHash } from '../types';
import { isLoadoutBuilderItem } from '../utils';
import ModPickerFooter from './ModPickerFooter';
import PickerSectionMods from './PickerSectionMods';

interface ProvidedProps {
  lockedMods: PluggableItemsByPlugCategoryHash;
  classType: DestinyClass;
  initialQuery?: string;
  onAccept(newLockedMods: PluggableItemsByPlugCategoryHash): void;
  onClose(): void;
}

interface StoreProps {
  language: string;
  isPhonePortrait: boolean;
  defs: D2ManifestDefinitions;
  buckets: InventoryBuckets;
  mods: PluggableInventoryItemDefinition[];
}

type Props = ProvidedProps & StoreProps;

function mapStateToProps() {
  /** Build the hashes of all plug set item hashes that are unlocked by any character/profile. */
  const unlockedModsSelector = createSelector(
    profileResponseSelector,
    allItemsSelector,
    (state: RootState) => state.manifest.d2Manifest!,
    (_: RootState, props: ProvidedProps) => props.classType,
    (
      profileResponse: DestinyProfileResponse,
      allItems: DimItem[],
      defs: D2ManifestDefinitions,
      classType?: DestinyClass
    ): PluggableInventoryItemDefinition[] => {
      const plugSets: { [bucketHash: number]: Set<number> } = {};
      if (!profileResponse || classType === undefined) {
        return [];
      }

      // 1. loop through all items, build up a map of mod sockets by bucket
      for (const item of allItems) {
        if (
          !item ||
          !item.sockets ||
          !isLoadoutBuilderItem(item) ||
          !(item.classType === DestinyClass.Unknown || item.classType === classType)
        ) {
          continue;
        }
        if (!plugSets[item.bucket.hash]) {
          plugSets[item.bucket.hash] = new Set<number>();
        }
        // build the filtered unique mods
        item.sockets.allSockets
          .filter((s) => !s.isPerk)
          .forEach((socket) => {
            if (socket.socketDefinition.reusablePlugSetHash) {
              plugSets[item.bucket.hash].add(socket.socketDefinition.reusablePlugSetHash);
            }
          });
      }

      // 2. for each unique socket (type?) get a list of unlocked mods
      const allUnlockedMods = Object.values(plugSets).flatMap((sets) => {
        const unlockedPlugs: number[] = [];

        for (const plugSetHash of sets) {
          const plugSetItems = itemsForPlugSet(profileResponse, plugSetHash);
          for (const plugSetItem of plugSetItems) {
            if (plugIsInsertable(plugSetItem)) {
              unlockedPlugs.push(plugSetItem.plugItemHash);
            }
          }
        }

        const finalMods: PluggableInventoryItemDefinition[] = [];

        for (const plug of unlockedPlugs) {
          const def = defs.InventoryItem.get(plug);

          if (
            isPluggableItem(def) &&
            isArmor2Mod(def) &&
            // Filters out mods that are deprecated.
            (def.plug.insertionMaterialRequirementHash !== 0 || def.plug.energyCost?.energyCost) &&
            // This string can be empty so let those cases through in the event a mod hasn't been given a itemTypeDisplayName.
            // My investigation showed that only classified items had this being undefined.
            def.itemTypeDisplayName !== undefined
          ) {
            finalMods.push(def);
          }
        }

        return finalMods.sort(sortMods);
      });

      return _.uniqBy(allUnlockedMods, (unlocked) => unlocked.hash);
    }
  );
  return (state: RootState, props: ProvidedProps): StoreProps => ({
    isPhonePortrait: state.shell.isPhonePortrait,
    buckets: bucketsSelector(state)!,
    language: settingsSelector(state).language,
    defs: state.manifest.d2Manifest!,
    mods: unlockedModsSelector(state, props),
  });
}

/**
 * A sheet to pick mods that are required in the final loadout sets.
 */
function ModPicker({
  defs,
  mods,
  language,
  isPhonePortrait,
  lockedMods,
  initialQuery,
  onAccept,
  onClose,
}: Props) {
  const [query, setQuery] = useState(initialQuery || '');
  const [lockedModsInternal, setLockedModsInternal] = useState(() => ({ ...lockedMods }));
  const filterInput = useRef<SearchFilterRef | null>(null);

  useEffect(() => {
    if (!isPhonePortrait && filterInput.current) {
      filterInput.current.focusFilterInput();
    }
  }, [isPhonePortrait, filterInput]);

  /** Add a new mod to the internal mod picker state */
  const onModSelected = useCallback(
    (mod: PluggableInventoryItemDefinition) => {
      const { plugCategoryHash } = mod.plug;
      setLockedModsInternal((oldState) => ({
        ...oldState,
        [plugCategoryHash]: [...(oldState[plugCategoryHash] || []), { ...mod }],
      }));
    },
    [setLockedModsInternal]
  );

  /** Remove a mod from the internal mod picker state */
  const onModRemoved = useCallback(
    (mod: PluggableInventoryItemDefinition) => {
      const { plugCategoryHash } = mod.plug;
      setLockedModsInternal((oldState) => {
        const firstIndex =
          oldState[plugCategoryHash]?.findIndex((locked) => locked.hash === mod.hash) ?? -1;

        if (firstIndex >= 0) {
          const newState = [...(oldState[plugCategoryHash] || [])];
          newState.splice(firstIndex, 1);
          return {
            ...oldState,
            [plugCategoryHash]: newState,
          };
        }

        return oldState;
      });
    },
    [setLockedModsInternal]
  );

  const onSubmit = (e: React.FormEvent | KeyboardEvent, onClose: () => void) => {
    e.preventDefault();
    onAccept(lockedModsInternal);
    onClose();
  };

  const queryFilteredMods = useMemo(() => {
    // Only some languages effectively use the \b regex word boundary
    const regexp = ['de', 'en', 'es', 'es-mx', 'fr', 'it', 'pl', 'pt-br'].includes(language)
      ? new RegExp(`\\b${escapeRegExp(query)}`, 'i')
      : new RegExp(escapeRegExp(query), 'i');
    return query.length
      ? mods.filter(
          (mod) =>
            regexp.test(mod.displayProperties.name) ||
            regexp.test(mod.displayProperties.description) ||
            regexp.test(mod.itemTypeDisplayName) ||
            (query.startsWith('plugCategoryHash:in:') &&
              query.includes(`${mod.plug.plugCategoryHash}`)) ||
            mod.perks.some((perk) => {
              const perkDef = defs.SandboxPerk.get(perk.perkHash);
              return (
                perkDef &&
                (regexp.test(perkDef.displayProperties.name) ||
                  regexp.test(perkDef.displayProperties.description) ||
                  regexp.test(perk.requirementDisplayString))
              );
            })
        )
      : mods;
  }, [language, query, mods, defs.SandboxPerk]);

  const groupedMods = Object.values(
    _.groupBy(queryFilteredMods, (mod) => mod.plug.plugCategoryHash)
  ).sort(sortModGroups);

  const plugCategoryHashOrder = groupedMods.map((mods) => mods[0].plug.plugCategoryHash);

  const autoFocus =
    !isPhonePortrait && !(/iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream);

  const footer = Object.values(lockedModsInternal).some((f) => Boolean(f?.length))
    ? ({ onClose }) => (
        <ModPickerFooter
          defs={defs}
          groupOrder={plugCategoryHashOrder}
          locked={lockedModsInternal}
          isPhonePortrait={isPhonePortrait}
          onSubmit={(e) => onSubmit(e, onClose)}
          onModSelected={onModRemoved}
        />
      )
    : undefined;

  return (
    <Sheet
      onClose={onClose}
      header={
        <div>
          <h1>{t('LB.ChooseAMod')}</h1>
          <div className="item-picker-search">
            <div className="search-filter" role="search">
              <AppIcon icon={searchIcon} className="search-bar-icon" />
              <input
                className="filter-input"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                autoFocus={autoFocus}
                placeholder={t('LB.SearchAMod')}
                type="text"
                name="filter"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
              />
            </div>
          </div>
        </div>
      }
      footer={footer}
      sheetClassName="item-picker"
      freezeInitialHeight={true}
    >
      {groupedMods.map((mods) => (
        <PickerSectionMods
          key={mods[0].plug.plugCategoryHash}
          mods={mods}
          defs={defs}
          locked={lockedModsInternal}
          onModSelected={onModSelected}
          onModRemoved={onModRemoved}
        />
      ))}
    </Sheet>
  );
}

export default connect<StoreProps>(mapStateToProps)(ModPicker);
