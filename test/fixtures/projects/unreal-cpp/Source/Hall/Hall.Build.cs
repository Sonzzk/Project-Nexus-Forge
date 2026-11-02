using UnrealBuildTool;

public class Hall : ModuleRules
{
	public Hall(ReadOnlyTargetRules Target) : base(Target)
	{
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "Engine" });
	}
}
