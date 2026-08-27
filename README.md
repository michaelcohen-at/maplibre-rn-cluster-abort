# `GeoJSONSource`: disabling `cluster` leaves the native source clustered, then aborts the process

Setting `cluster={false}` on a `<GeoJSONSource>` that was mounted with `cluster={true}` does not
disable clustering natively. The next `data` push is still handed to supercluster, and because
supercluster requires every feature to be a `Point`, any other geometry throws
`mapbox::util::bad_variant_access` from C++ and the app dies with `SIGABRT`.

The throw crosses an Objective-C++ boundary with no handler, so it is **not catchable from
JavaScript** — no error boundary, no redbox, just process death.

| | |
|---|---|
| `@maplibre/maplibre-react-native` | `11.3.6` |
| `react-native` | `0.86.3` (new architecture / Fabric) |
| `expo` | `~57.0.17` |
| Platform | iOS (reproduced on simulator, iOS 26.4, and on device, iOS 26.6 / 26.6.1) |

## Reproduce

```bash
npm install
npx expo prebuild --platform ios
npx expo run:ios
```

The app drives itself — no interaction needed. It renders one `<GeoJSONSource>` and, three seconds
after the style loads, flips that **same source** from

- `cluster={true}` with 20 `Point` features, to
- `cluster={false}` with one `Polygon` feature.

**Expected:** the source stops clustering and renders the polygon.

**Actual:** `SIGABRT` during the commit.

Every feature in `App.tsx` is valid GeoJSON, and the polygon is only ever rendered by a source whose
props say `cluster={false}`. Nothing in the app asks for a clustered polygon source.

## Stack

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

## Cause

Three things in the iOS implementation combine.

**1. Cluster options are only ever read at source-construction time.**
`ios/components/sources/geojson-source/MLRNGeoJSONSource.m` builds `cluster`, `clusterRadius`,
`clusterProperties` etc. in `_getOptions`, and `_getOptions` is called from exactly one place —
`makeSource`. `MLNShapeSource` options are immutable after construction, so once the source exists
there is no path that can turn clustering off:

```objc
- (nullable MLNSource *)makeSource {
  NSDictionary<MLNShapeSourceOption, id> *options = [self _getOptions];   // only caller
  if (_shape != nil) {
    return [[MLNShapeSource alloc] initWithIdentifier:self.id shape:shape options:options];
  }
  ...
}
```

**2. `updateProps` applies `data` before `cluster`.**
In `MLRNGeoJSONSourceComponentView.mm`, `data` is pushed at line 79, and `cluster` /
`clusterRadius` / `clusterProperties` at lines 83–106. So even if changing the cluster props did
rebuild the source, the new `data` would already have been fed to the old one:

```objc
if (oldViewProps.data != newViewProps.data) {
  [_view setReactData:RCTNSStringFromString(newViewProps.data)];   // line 79 — first
}
if (oldViewProps.cluster != newViewProps.cluster) {
  _view.cluster = @(newViewProps.cluster);                          // line 83 — too late
}
```

**3. An existing native source is adopted without reconciling its options.**
`ios/components/sources/MLRNSource.m`:

```objc
- (void)addToMap {
  MLNSource *existingSource = [_map.style sourceWithIdentifier:_id];
  if (existingSource != nil) {
    _source = existingSource;      // adopted as-is, options never compared
  } else {
    _source = [self makeSource];
  }
  ...
}
```

Related, and probably the same fix: `removeFromMap` removes the source from the style but leaves
`_source` set, and `setShape:` only guards on `self.source != nil`. A source that has been removed
therefore still accepts data pushes. `MLRNGeoJSONSourceComponentView` also does not implement
`prepareForRecycle` (`MLRNCameraComponentView` and `MLRNLayerComponentView` both do), so a recycled
source view keeps the previous component's native `MLNShapeSource`, cluster options and all.

## Suggested fix

Rebuild the native source when any option in `_getOptions` changes, rather than only on first
mount — i.e. in `updateProps`, detect an options change, and remove + recreate the `MLNShapeSource`
before applying the new `data`. Failing that, `addToMap` should not adopt an existing source whose
options differ from the current props, `removeFromMap` should clear `_source`, and
`MLRNGeoJSONSourceComponentView` should implement `prepareForRecycle`.

A defensive guard in `setShape:` (skip or drop non-`Point` features when the source is clustered)
would also turn a process abort into a render no-op, which seems worth having regardless, since the
C++ throw is unreachable from JS.

## Why this matters

The abort is unrecoverable and unattributable from the JS side. In our app it surfaced as a crash
when users switched between map layers — a clustered point layer being replaced by a polygon layer
— with no JS error to point at the cause.
