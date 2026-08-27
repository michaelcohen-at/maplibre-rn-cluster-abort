# A single `geometry: null` feature in a clustered `GeoJSONSource` aborts the process

Pushing a `FeatureCollection` that contains **one feature with `geometry: null`** into a
`<GeoJSONSource cluster>` kills the app with `SIGABRT`.

`geometry: null` is legal GeoJSON — [RFC 7946 §3.2](https://datatracker.ietf.org/doc/html/rfc7946#section-3.2)
says a Feature's `geometry` member "MAY be null". But maplibre's clustering path calls
`geometry.get<mapbox::geometry::point<double>>()` on every feature, which throws
`mapbox::util::bad_variant_access` for a null geometry (it deserializes to
`mapbox::geometry::empty`, the first member of that variant).

The throw happens in C++, crosses an Objective-C++ boundary with no handler, and becomes
`std::terminate` → `abort`. **It is not catchable from JavaScript** — no error boundary, no redbox,
no JS stack. The app simply dies, which makes it very hard to attribute in production.

| | |
|---|---|
| `@maplibre/maplibre-react-native` | `11.3.6` |
| `react-native` | `0.86.3` (new architecture / Fabric) |
| `expo` | `~57.0.17` |
| Reproduced on | iOS 26.4 simulator; iOS 26.6 / 26.6.1 devices (iPhone 15 Pro, iPhone 17) |

## Reproduce

```bash
npm install
npx expo prebuild --platform ios     # the config plugin must be in app.json "plugins",
npx expo run:ios                     # otherwise the build fails: 'MapLibre/MapLibre.h' not found
```

No interaction needed. The app renders one `<GeoJSONSource>` with `cluster` enabled — **`cluster`
never changes** — and steps its `data` prop every 2.5s, logging each step before it renders:

```
[repro] step 0 baseline: 20 Points                    <- fine
[repro] step 1 swap to 12 different Points            <- fine
[repro] step 2 Points + ONE null-geometry feature     <- SIGABRT here
```

Step 1 is deliberate: replacing a clustered source's data is *not* the problem on its own. Only the
null geometry is.

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

Note `mapbox::geometry::empty` as the first variant member — that is the null geometry.

## Suggested fix

`-[MLRNGeoJSONSource setShape:]` is the last place that can prevent this cheaply. When the source is
clustered, features whose geometry is not a `Point` cannot be clustered by supercluster at all, so
dropping them (with an `RCTLogWarn`) turns a process abort into a render no-op:

```objc
- (void)setShape:(NSString *)shape {
  _shape = shape;
  if (self.source != nil) {
    MLNShapeSource *source = (MLNShapeSource *)self.source;
    [source setShape:shape == nil ? nil : [MLRNUtils shapeFromGeoJSON:_shape]];
  }
}
```

Doing it in the shared native layer is preferable to asking every app to pre-filter, because the
failure mode is a hard crash with no JS-side signal.

## A second, related problem

`cluster` and the other clustering props cannot be changed after mount, so an app cannot even work
around the above by turning clustering off:

- `MLRNGeoJSONSource.m` — `_getOptions` (which builds `cluster`, `clusterRadius`,
  `clusterProperties`) is called from exactly one place, `makeSource`. `MLNShapeSource` options are
  immutable after construction.
- `MLRNGeoJSONSourceComponentView.mm` — `updateProps` pushes `data` at line 79, *before* `cluster`
  at line 83, so even a rebuild-on-change would receive the new data first.
- `MLRNSource.m` — `addToMap` adopts an existing style source by id (`_source = existingSource`)
  without comparing options; `removeFromMap` removes the source from the style but leaves `_source`
  set, and `setShape:` only guards on `self.source != nil`, so a removed source still accepts data
  pushes. `MLRNGeoJSONSourceComponentView` also does not implement `prepareForRecycle`, unlike
  `MLRNCameraComponentView` and `MLRNLayerComponentView`.

Setting `cluster={false}` on a mounted source and pushing a `Polygon` therefore aborts in the same
way. `git log` in this repo has that variant as its first commit if it is useful.

## Why this matters

In our app this surfaced as a crash when users switched between map layers — no JS error, no
attribution, just process death on devices in the field.
