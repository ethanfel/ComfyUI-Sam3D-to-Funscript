import assert from 'node:assert/strict';
import {motionSections, sectionAt, trackLabel, processingTrackState, latestTrack, recreatedTrackChoices, sourceChoices} from '../assets/timeline.mjs';

const namedProject={timeline:{latest:{crop:'new'},sources:[
    {id:'old',input:'crop',data:{metadata:{processing_region:{name:'Tracking 33 crop'}},config:{target_anchor:'mouth',target_person:0}}},
    {id:'new',input:'crop',data:{metadata:{processing_region:{name:'Tracking 31 crop'}},config:{target_anchor:'mouth',target_person:0}}}
]}};
const namedTrack={name:'Tracking 33 crop · mouth',source:'new'};
assert.equal(trackLabel(namedProject,namedTrack),'Tracking 31 crop · mouth','automatic names follow the current source region');
assert.equal(trackLabel(namedProject,{...namedTrack,source:'old'}),'Tracking 33 crop · mouth','saved sources keep their own identity');
for(const protection of [{custom_name:true},{window:[100,200]}])assert.equal(trackLabel(namedProject,{...namedTrack,...protection}),namedTrack.name);
assert.equal(trackLabel(namedProject,{...namedTrack,locked:true}),'Tracking 31 crop · mouth','locking does not revert to a stale row name');
assert.equal(trackLabel(namedProject,{...namedTrack,locked:true,source:'old'}),'Tracking 33 crop · mouth','locked rows keep their own historical source name');
assert.equal(trackLabel(namedProject,{name:'Manual input',source:'missing'}),'Manual input');
assert.equal(trackLabel(namedProject,null),null);
assert.match(sourceChoices(namedProject)[1].label,/Tracking 31 crop.*latest/);
assert.equal(namedTrack.name,'Tracking 33 crop · mouth','display labels do not mutate saved curves or names');

const source=(id,region,anchor='mouth')=>({id,data:{metadata:{processing_region:{id:region,name:'Same name',start_ms:100,end_ms:200}},config:{target_anchor:anchor}}});
const original={timeline:{latest:{old:'s0'},sources:[source('s0','r0')],tracks:[{id:'t0',source:'s0',axis:'L0'}]}};
const replaced={timeline:{latest:{new:'s1'},sources:[...original.timeline.sources,source('s1','r1')],tracks:[...original.timeline.tracks,{id:'t1',source:'s1',axis:'L0'}]}};
const beforeReplacement=structuredClone(replaced);
assert.deepEqual([...recreatedTrackChoices(replaced,original)],[['t0','t1']]);
assert.equal(processingTrackState(replaced,replaced.timeline.tracks[0]),'Previous detection');
assert.equal(processingTrackState(replaced,replaced.timeline.tracks[1]),'Latest detection');
assert.deepEqual(replaced,beforeReplacement,'only view choices are proposed; saved data is immutable');
assert.equal(recreatedTrackChoices(replaced,replaced).size,0,'choosing an older detection manually remains possible');
const renamed=structuredClone(replaced);renamed.timeline.sources[1].data.metadata.processing_region.name='Different name';
assert.equal(recreatedTrackChoices(renamed,original).get('t0'),'t1','identity does not depend on names');
const distant=structuredClone(replaced);distant.timeline.sources[1].data.metadata.processing_region.start_ms=300;
assert.equal(recreatedTrackChoices(distant,original).size,0,'unrelated intervals cannot redirect a selection');
const retained=structuredClone(replaced);retained.timeline.latest.old='s0';
assert.equal(recreatedTrackChoices(retained,original).size,0,'an additional detection does not retire the selected region');
const ambiguous=structuredClone(replaced);ambiguous.timeline.sources.push(source('s2','r2'));ambiguous.timeline.latest.other='s2';ambiguous.timeline.tracks.push({id:'t2',source:'s2',axis:'L0'});
assert.equal(recreatedTrackChoices(ambiguous,original).size,0,'ambiguous replacements require explicit selection');
const fitted=structuredClone(original);fitted.timeline.tracks[0].window=[110,150];
assert.equal(recreatedTrackChoices(replaced,fitted).size,0,'local fitted tracks stay selected');

const ranges = [{id:'a', start:100, end:200}, {id:'b', start:200, end:300},
    {id:'hand', start:200, end:300}, {id:'fit', start:240, end:260}, {id:'c', start:400, end:450}];
const before = structuredClone(ranges);
const sections = motionSections(ranges, ['hand']);
assert.deepEqual(sections.map(s => [s.start,s.end,s.id]), [[100,200,'a'],[200,240,'hand'],[240,260,'hand'],[260,300,'hand'],[400,450,'c']]);
assert.deepEqual(sections[2].choices, ['b','hand','fit']);
assert.equal(sectionAt(sections, 200).id, 'hand', 'shared boundaries belong to the next section');
assert.equal(sectionAt(sections, 350), null, 'unprocessed gaps stay empty');
assert.equal(sectionAt(sections, 450), null);
assert.equal(sectionAt(motionSections(ranges, ['fit','hand']), 250).id, 'fit');
assert.equal(sectionAt(motionSections(ranges, ['hand','b','hand']), 210).id, 'hand','fallback choices cannot override the selected anchor');
assert.deepEqual(ranges, before, 'display layout cannot alter source coverage or data');
assert.deepEqual(motionSections([]), []);
assert.deepEqual(motionSections([{id:'bad',start:10,end:0}]), []);
console.log('Motion sections: consecutive ranges, alternate anchors, partial overlaps, gaps and boundary ownership passed');

const rerun=structuredClone(replaced);
rerun.timeline.sources[1].data.metadata.processing_region.id='r0';
assert.equal(latestTrack(rerun,rerun.timeline.tracks[0]).id,'t1','rerunning the same region selects its latest snapshot');
assert.equal(recreatedTrackChoices(rerun,original).get('t0'),'t1');
assert.equal(latestTrack(ambiguous,ambiguous.timeline.tracks[0]).id,'t0','ambiguous matching never picks a random anchor');
rerun.timeline.sources[1].data.config.target_person=1;
assert.equal(latestTrack(rerun,rerun.timeline.tracks[0]).id,'t0','latest must follow the same person');

assert.equal(recreatedTrackChoices(rerun,original).size,0,'a rerun cannot silently switch to a different person');
