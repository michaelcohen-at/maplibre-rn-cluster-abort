# iOS: recycled `GeoJSONSource` component view retains a clustered `MLNShapeSource`, causing SIGABRT on next mount

> **This branch (`fix/recycled-clustered-source`) carries the proposed fix.**
> `patches/@maplibre+maplibre-react-native+11.3.6.patch` is applied to the library by `patch-package`
> on `npm install`. With it, **Run repro** completes all four steps and renders the polygon;
> `main` is the unpatched baseline, where the same sequence aborts at step 2.
>
> The patch makes the three changes listed under *Proposed fix*, each also proposed in
> [maplibre/maplibre-react-native#1635](https://github.com/maplibre/maplibre-react-native/issues/1635).
> Verified on the iOS 26.4 simulator: repro survives, control survives, and the `setShape:` filter's
> warning never fires — fixes 1 and 2 stop the stale source being reached at all, so fix 3 stays
> dormant as defence in depth.
>
> ```bash
> git checkout fix/recycled-clustered-source
> npm install                          # patch-package applies the patch (postinstall)
> npx expo prebuild --platform ios
> EXPO_PUBLIC_AUTORUN=repro npx expo run:ios
> ```

## Summary

When a `<GeoJSONSource cluster>` is unmounted and a non-clustered `<GeoJSONSource>` is subsequently
mounted, Fabric supplies the second component with the first component's recycled
`MLRNGeoJSONSourceComponentView`. That view still references the first component's
`MLNShapeSource`, which was constructed with clustering enabled. The second component's `data` is
written to this stale source via `setShape:`. Supercluster requires `Point` geometries; any other
geometry type causes `mapbox::util::variant::get<point<double>>()` to throw
`bad_variant_access`. The exception propagates through an Objective-C++ frame with no handler,
resulting in `std::terminate` and `SIGABRT`.

The two components are unrelated: different `id`, different React key, valid GeoJSON, correct
props. The failure is not observable or catchable from JavaScript.

## Environment

| Component | Version |
|---|---|
| `@maplibre/maplibre-react-native` | 11.3.6 |
| `react-native` | 0.86.3, new architecture (Fabric) |
| `expo` | ~57.0.17 |
| Platforms | iOS 26.4 (simulator); iOS 26.6, 26.6.1 (iPhone 15 Pro, iPhone 17) |

Android has not been tested.

## Steps to reproduce

```bash
npm install
npx expo prebuild --platform ios
npx expo run:ios
```

`app.json` must list `@maplibre/maplibre-react-native` under `plugins`; without the config plugin
the iOS build fails with `'MapLibre/MapLibre.h' file not found`.

The app exposes two buttons. Each executes a three-step sequence with a 2.5 s interval, emitting
`[repro] <mode> step N` to the console before each render. The final logged line therefore
identifies the step during which the process terminated.

**Run repro**

| Step | Render | Result |
|---|---|---|
| 0 | `<GeoJSONSource id="traps" cluster>` with 20 `Point` features | OK |
| 1 | nothing (source unmounted; view enters the recycle pool) | OK |
| 2 | `<GeoJSONSource id="blocks">` with 1 `Polygon` feature | **SIGABRT** |

**Run control**

Identical operations in reverse order.

| Step | Render | Result |
|---|---|---|
| 0 | `<GeoJSONSource id="blocks">` with 1 `Polygon` feature | OK |
| 1 | nothing | OK |
| 2 | `<GeoJSONSource id="traps" cluster>` with 20 `Point` features | OK |
| 3 | unchanged | OK |

In the control, the recycled view retains a non-clustered `MLNShapeSource`. Writing `Point`
features to it does not invoke supercluster, so no exception is thrown. The sole variable between
the two sequences is the order in which the sources are mounted.

**Run remount (same id)** — a regression guard for the fix, not a reproduction of the bug

| Step | Render | Result (unpatched) |
|---|---|---|
| 0 | `<GeoJSONSource id="traps" cluster>` with 20 `Point` features | OK |
| 1 | nothing | OK |
| 2 | the same `<GeoJSONSource id="traps" cluster>` again | OK |

This is what a data-driven layer does when it renders `null` while its next payload loads. It
passes on the unpatched library. It exists because the obvious fix — a `prepareForRecycle` that
recreates the wrapped `MLRNGeoJSONSource` — is incomplete on its own: Fabric passes
`oldProps:nullptr` on `Create`, `updateProps` diffs against `_props`, and `_props` still holds the
previous component's values. Any prop equal to the previous component's (here `id` and `cluster`)
is therefore never applied to the fresh wrapper, and `addToMap` calls
`-[MLNStyle sourceWithIdentifier:]` with a nil `id`, which segfaults in `strlen`. The reset of
`_props` to the default props must accompany the recreation, as `MLRNCameraComponentView.prepareView`
already does.

Hands-free: `EXPO_PUBLIC_AUTORUN=repro|control|remount npx expo start` starts a sequence as soon as
the style loads (inlined at bundle time; restart metro after changing it).

## Expected behaviour

Mounting a non-clustered `GeoJSONSource` creates or adopts a non-clustered native source and
renders the supplied geometry.

## Actual behaviour

The process aborts during the Fabric mount transaction for the second source.

## Stack trace

```
libc++abi   __cxa_throw
MapLibre    mapbox::util::variant<mapbox::geometry::empty,
                                  mapbox::geometry::point<double>,
                                  mapbox::geometry::line_string<double>,
                                  mapbox::geometry::pol...>::get<point<double>>  (supercluster.hpp:267)
MapLibre    mapbox::supercluster::Supercluster::Zoom::Zoom                       (supercluster.hpp:156)
MapLibre    mbgl::style::SuperclusterData::SuperclusterData                      (geojson_source_impl.cpp:78)
MapLibre    mbgl::style::GeoJSONData::create                                     (geojson_source_impl.cpp:128)
MapLibre    mbgl::style::GeoJSONSource::setGeoJSON                               (geojson_source.cpp:45)
MapLibre    -[MLNShapeSource setShape:]                                          (MLNShapeSource.mm:274)
app         -[MLRNGeoJSONSource setShape:]                                       (MLRNGeoJSONSource.m:32)
app         -[MLRNGeoJSONSource setReactData:]                                   (MLRNGeoJSONSource.m:15)
app         -[MLRNGeoJSONSourceComponentView updateProps:oldProps:]              (MLRNGeoJSONSourceComponentView.mm:80)
React       RCTPerformMountInstructions                                          (RCTMountingManager.mm:83)
```

`RCTMountingManager.mm:83` is the `ShadowViewMutation::Create` case, which calls
`updateProps:oldProps:nullptr` on the view returned by
`dequeueComponentViewWithComponentHandle:`.

## Root cause

Four conditions in the iOS implementation combine. Line references are to
`@maplibre/maplibre-react-native@11.3.6`; the React Native references are to 0.86.3.

**1. The component view is recycled with its native state intact.**
`RCTComponentViewDescriptor.shouldBeRecycled` defaults to `true`, and `RCTComponentViewRegistry`
maintains a per-component-handle LIFO pool. `RCTViewComponentView.prepareForRecycle` resets only
base-class state. `MLRNGeoJSONSourceComponentView` overrides neither `prepareForRecycle` nor
`shouldBeRecycled`, so its `_view` ivar — the `MLRNGeoJSONSource` instance holding `_source`,
`_shape`, `_cluster`, `_clusterRadius` and `_clusterProperties` — is carried unchanged into the
next component that dequeues the view. `MLRNCameraComponentView` and `MLRNLayerComponentView` do
implement `prepareForRecycle`.

**2. `removeFromMap` does not release the native source.**
`ios/components/sources/MLRNSource.m`:

```objc
- (void)removeFromMap {
  ...
  if (_source != nil) {
    [_map.style removeSource:_source];
  }
  // _source is not set to nil
}
```

No code under `ios/components/sources/` assigns `nil` to `source`. The removed `MLNShapeSource`
remains valid; `setShape:` on it still reaches `mbgl::style::GeoJSONSource::setGeoJSON`.

**3. `setShape:` writes to whatever `source` references.**
`ios/components/sources/geojson-source/MLRNGeoJSONSource.m`:

```objc
- (void)setShape:(NSString *)shape {
  _shape = shape;
  if (self.source != nil) {
    MLNShapeSource *source = (MLNShapeSource *)self.source;
    [source setShape:shape == nil ? nil : [MLRNUtils shapeFromGeoJSON:_shape]];
  }
}
```

On a recycled view, `self.source` is the previous component's clustered source.

**4. `updateProps` applies `data` before any other prop, and cluster options are immutable.**
`MLRNGeoJSONSourceComponentView.mm` writes `data` (line 79) before `cluster` (line 83) and the
remaining cluster options (lines 87–106). Independently, `_getOptions` is invoked only from
`makeSource`, and `MLNShapeSource` options cannot be changed after construction, so updating the
cluster props has no effect on an existing source in any case.

Sequence at step 2 of the repro: `dequeueComponentViewWithComponentHandle:` returns the recycled
view → `updateProps:oldProps:nullptr` → `data` differs → `setReactData:` → `setShape:` →
`self.source` is the stale clustered `MLNShapeSource` → `setGeoJSON` → `SuperclusterData` →
`get<point<double>>()` on a `Polygon` → throw → abort. This occurs before `addToMap` is called for
the new component.

## Trigger conditions in production

The defect requires a clustered `GeoJSONSource` to unmount and a non-clustered `GeoJSONSource` to
mount at any later point. Typical causes are a data-driven layer rendering `null` while a new
payload loads, screen navigation, or a change of map context. In the originating application the
crash occurred when stepping between dates on a clustered layer, and only when the target date was
not yet cached: uncached data caused the source to unmount during the fetch, whereas cached data
updated the `data` prop of a mounted source, which is unaffected.

## Proposed fix

1. `MLRNGeoJSONSourceComponentView`: implement `prepareForRecycle` — reset `_props` to the
   default props **and** re-run `prepareView` to allocate a fresh `MLRNGeoJSONSource`. Both halves
   are required: without the `_props` reset, props equal to the previous component's are never
   applied to the fresh wrapper (see *Run remount* above). This matches
   `MLRNCameraComponentView.prepareView`.
2. `MLRNSource.removeFromMap`: assign `_source = nil` after `removeSource:`, so that `setShape:`
   and `setURL:` cannot address a source that is no longer attached to the component.
3. `MLRNGeoJSONSource.setShape:`: when `_cluster` is enabled, filter out features whose geometry is
   not `Point` and emit `RCTLogWarn`. Supercluster cannot process them, and this converts a process
   abort into a logged no-op for any remaining path, including the related issue below.

Additionally, applying the cluster options before `data` in `updateProps`, and recreating the
`MLNShapeSource` when those options change, would make `cluster` mutable after mount. It is not
currently.

## Related: `geometry: null` in a clustered source

With `cluster` enabled and only `data` changing on a mounted source, replacing `Point` features
with other `Point` features is safe, but a single feature with `geometry: null` — permitted by
[RFC 7946 §3.2](https://datatracker.ietf.org/doc/html/rfc7946#section-3.2) — aborts with the same
stack. The null geometry deserialises to `mapbox::geometry::empty`, the first alternative of the
variant shown in frame 1. Proposed fix 3 covers this case. Commit `5b5eff1` in this repository is
a standalone harness for it.
